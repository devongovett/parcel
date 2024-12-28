use std::{borrow::Cow, collections::HashMap};

use crate::{
  utils::{CodeHighlight, Diagnostic, DiagnosticSeverity},
  Config, SourceLocation,
};
use markdown::{
  mdast::{AttributeValueExpression, Code, MdxjsEsm, Node, Text},
  message::{Message, Place},
  unist::Position,
};
use mdxjs::{
  hast::{AttributeContent, AttributeValue, MdxJsxAttribute, PropertyValue},
  hast_util_to_swc, mdast_util_from_mdx, mdast_util_to_hast, JsxRuntime, Options,
};
use parcel_macros::{Evaluator, JsValue};
use swc_core::{
  common::{
    comments::{Comments, SingleThreadedComments},
    sync::Lrc,
    SourceMap, DUMMY_SP,
  },
  ecma::{
    ast::{
      Decl, ExportDefaultExpr, ExportSpecifier, Expr, JSXElement, JSXElementName,
      JSXOpeningElement, Module, ModuleDecl, ModuleItem, Stmt, VarDeclKind,
    },
    atoms::JsWord,
    codegen::to_code,
    parser::{lexer::Lexer, EsSyntax, Parser, StringInput, Syntax, TsSyntax},
    utils::for_each_binding_ident,
  },
};

pub struct MdxResult {
  pub module: Module,
  pub comments: SingleThreadedComments,
  pub toc: Vec<TocNode>,
  pub exports: HashMap<JsWord, JsValue>,
  pub assets: Vec<MdxAsset>,
}

#[derive(serde::Serialize, Debug)]
pub struct MdxAsset {
  pub lang: String,
  pub code: String,
  pub position: Option<Position>,
}

pub fn mdx(config: &Config) -> Result<MdxResult, Diagnostic> {
  let mut options: Options = Options {
    filepath: Some(config.filename.clone()),
    development: config.is_development,
    jsx_import_source: config.jsx_import_source.clone(),
    jsx_runtime: Some(if config.automatic_jsx_runtime {
      JsxRuntime::Automatic
    } else {
      JsxRuntime::Classic
    }),
    pragma: config.jsx_pragma.clone(),
    pragma_frag: config.jsx_pragma_frag.clone(),
    ..Default::default()
  };

  let code = unsafe { std::str::from_utf8_unchecked(&config.code) };
  let mut ast = mdast_util_from_mdx(code, &options)?;
  let mut contents: Vec<_> = Vec::new();
  toc(&ast, &mut contents);

  let mut assets = Vec::new();
  transform_code(&mut ast, &mut assets);
  if !assets.is_empty() {
    options.provider_import_source = Some("@parcel/transformer-js/src/mdx-components".into());
    let children = ast.children_mut().unwrap();
    let imports = (0..assets.len()).map(|i| {
      Node::MdxjsEsm(MdxjsEsm {
        value: format!("import __parcelMdxImport{} from 'mdx-{}'", i, i),
        position: None,
        stops: vec![],
      })
    });
    children.extend(imports);
  }

  let mut hast = mdast_util_to_hast(&ast);
  collect_deps(&mut hast);

  let program = hast_util_to_swc(&hast, code, &options)?;
  let exports = constant_exports(&program.module);

  let comments = SingleThreadedComments::default();
  for c in program.comments {
    comments.add_leading(c.span.lo, c.clone());
  }

  Ok(MdxResult {
    module: program.module,
    comments,
    toc: contents,
    exports,
    assets,
  })
}

#[derive(serde::Serialize, Debug)]
pub struct TocNode {
  pub title: String,
  pub level: u8,
  pub children: Vec<TocNode>,
}

fn toc(node: &Node, results: &mut Vec<TocNode>) {
  match node {
    Node::Heading(heading) => {
      let toc = TocNode {
        title: text(node).into_owned(),
        level: heading.depth,
        children: Vec::new(),
      };

      let mut children = results;
      while let Some(last) = children.last() {
        if toc.level > last.level {
          children = &mut children.last_mut().unwrap().children;
        } else {
          break;
        }
      }
      children.push(toc);
    }
    _ => {
      if let Some(children) = node.children() {
        for child in children {
          toc(child, results)
        }
      }
    }
  }
}

fn text<'a>(node: &'a Node) -> Cow<'a, str> {
  match node {
    Node::Text(text) => Cow::Borrowed(&text.value),
    _ => {
      let mut result = Cow::Borrowed("");
      if let Some(children) = node.children() {
        for child in children {
          result += text(child);
        }
      }
      result
    }
  }
}

fn collect_deps(node: &mut mdxjs::hast::Node) {
  use mdxjs::hast::Node;
  match node {
    Node::Element(el) => {
      for (prop, value) in &mut el.properties {
        if is_url(&el.tag_name, prop) {
          if let PropertyValue::String(specifier) = value {
            *value = PropertyValue::JsxExpression(format!(
              "__parcel_url_dep__({:?}, {})",
              specifier,
              el.tag_name == "a" || el.tag_name == "iframe"
            ));
          }
        }
      }

      for child in &mut el.children {
        collect_deps(child);
      }
    }
    Node::MdxJsxElement(el) => {
      if let Some(name) = &el.name {
        for attr in &mut el.attributes {
          if let AttributeContent::Property(prop) = attr {
            if let Some(AttributeValue::Literal(specifier)) = &prop.value {
              if is_url(name, &prop.name) {
                prop.value = Some(AttributeValue::Expression(AttributeValueExpression {
                  value: format!(
                    "__parcel_url_dep__({:?}, {})",
                    specifier,
                    name == "a" || name == "iframe"
                  ),
                  stops: vec![],
                }));
              }
            }
          }
        }
      }
    }
    Node::Root(root) => {
      for child in &mut root.children {
        collect_deps(child);
      }
    }
    _ => {}
  }
}

fn is_url(el: &str, prop: &str) -> bool {
  matches!(
    (el, prop),
    ("img", "src")
      | ("audio", "src")
      | ("video", "src")
      | ("video", "poster")
      | ("source", "src")
      | ("track", "src")
      | ("iframe", "src")
      | ("script", "src")
      | ("embed", "src")
      | ("a", "href")
      | ("link", "href")
      | ("use", "href")
      | ("use", "xlink:href")
      | ("script", "href")
      | ("script", "xlink:href")
      | ("image", "href")
      | ("image", "xlink:href")
  )
}

fn constant_exports(module: &Module) -> HashMap<JsWord, JsValue> {
  let mut exports = HashMap::new();
  let sm = Default::default();
  let mut evaluator = Evaluator::new(&sm);

  for item in &module.body {
    match item {
      ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(exp)) => {
        if let Decl::Var(var) = &exp.decl {
          if var.kind == VarDeclKind::Const {
            for decl in &var.decls {
              if let Some(expr) = &decl.init {
                let val = evaluator.eval(&*expr);
                evaluator.eval_pat(val, &decl.name);

                for_each_binding_ident(&decl.name, |id| {
                  if let Some(Ok(val)) = evaluator.constants.get(&id.to_id()) {
                    exports.insert(id.id.sym.clone(), val.clone());
                  }
                });
              }
            }
          }
        }
      }
      _ => {}
    }
  }

  exports
}

/// Transform code fences with language and meta string into <CodeBlock> components.
fn transform_code(node: &mut Node, assets: &mut Vec<MdxAsset>) {
  match node {
    Node::Code(code) if code.lang.is_some() => {
      if let Some(replacement) = parse_code_block(code, assets) {
        *node = replacement;
      }
    }
    _ => {
      if let Some(children) = node.children_mut() {
        for child in children {
          transform_code(child, assets);
        }
      }
    }
  }
}

fn parse_code_block(code: &Code, assets: &mut Vec<MdxAsset>) -> Option<Node> {
  // Parse meta string as JSX props.
  let ast = if let Some(meta) = &code.meta {
    mdast_util_from_mdx(&format!("<CodeBlock {} />", meta), &Default::default()).ok()?
  } else {
    mdast_util_from_mdx("<CodeBlock />", &Default::default()).ok()?
  };

  if let Node::Root(root) = ast {
    let mut node = root.children.into_iter().next().unwrap();
    if let Node::MdxJsxFlowElement(ref mut element) = node {
      if let Some(lang) = &code.lang {
        element
          .attributes
          .push(AttributeContent::Property(MdxJsxAttribute {
            name: "lang".into(),
            value: Some(AttributeValue::Literal(lang.clone())),
          }));

        // Create an asset if the `render` prop is set to true.
        if let Some(attr_idx) = element
          .attributes
          .iter()
          .position(|attr| matches!(attr, AttributeContent::Property(p) if p.name == "render"))
        {
          if matches!(lang.as_str(), "js" | "jsx" | "ts" | "tsx") {
            if let AttributeContent::Property(attr) = &mut element.attributes[attr_idx] {
              attr.value = Some(AttributeValue::Expression(AttributeValueExpression {
                value: format!("__parcelMdxImport{}", assets.len()),
                stops: vec![],
              }));

              assets.push(MdxAsset {
                lang: lang.clone(),
                code: transform_js_code_block(&code.value, lang),
                position: code.position.clone(),
              });
            }
          } else {
            element.attributes.remove(attr_idx);
            assets.push(MdxAsset {
              lang: lang.clone(),
              code: code.value.to_owned(),
              position: code.position.clone(),
            });
          }
        }
      }

      element.children = vec![Node::Text(Text {
        value: code.value.clone(),
        position: code.position.clone(),
      })];
      element.position = code.position.clone();
      return Some(node);
    }
  }

  None
}

fn transform_js_code_block(code: &str, lang: &str) -> String {
  let code = code.to_owned();
  let source_map = Lrc::new(SourceMap::default());
  let source_file =
    source_map.new_source_file(Lrc::new(swc_core::common::FileName::Anon), code.clone());

  let lexer = Lexer::new(
    if lang == "ts" || lang == "tsx" {
      Syntax::Typescript(TsSyntax {
        tsx: lang == "tsx",
        ..Default::default()
      })
    } else {
      Syntax::Es(EsSyntax {
        jsx: lang == "jsx",
        ..Default::default()
      })
    },
    Default::default(),
    StringInput::from(&*source_file),
    None,
  );

  let mut parser = Parser::new_from(lexer);
  match parser.parse_module() {
    Err(_) => code,
    Ok(mut module) => {
      // Export the last declaration or expression if there are no explicit exports.
      if !has_default_export(&module) {
        let mut export_name = None;
        for item in module.body.iter_mut().rev() {
          match item {
            ModuleItem::Stmt(Stmt::Decl(decl)) => {
              match decl {
                Decl::Class(c) => {
                  export_name = Some(c.ident.clone());
                }
                Decl::Fn(f) => {
                  export_name = Some(f.ident.clone());
                }
                _ => continue,
              }
              break;
            }
            ModuleItem::Stmt(Stmt::Expr(expr)) => {
              *item = ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(ExportDefaultExpr {
                expr: expr.expr.clone(),
                span: expr.span,
              }));
              break;
            }
            _ => {}
          }
        }

        if let Some(export_name) = export_name {
          module
            .body
            .push(ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(
              ExportDefaultExpr {
                expr: Box::new(Expr::JSXElement(Box::new(JSXElement {
                  opening: JSXOpeningElement {
                    name: JSXElementName::Ident(export_name),
                    attrs: vec![],
                    self_closing: true,
                    type_args: None,
                    span: DUMMY_SP,
                  },
                  children: vec![],
                  closing: None,
                  span: DUMMY_SP,
                }))),
                span: DUMMY_SP,
              },
            )));
        }
      }

      to_code(&module)
    }
  }
}

fn has_default_export(module: &Module) -> bool {
  module.body.iter().any(|item| match item {
    ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultDecl(_))
    | ModuleItem::ModuleDecl(ModuleDecl::ExportDefaultExpr(_)) => true,
    ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(n)) => n.specifiers.iter().any(|s| match s {
      ExportSpecifier::Default(_) => true,
      ExportSpecifier::Namespace(_) => false,
      ExportSpecifier::Named(named) => {
        matches!(&named.exported, Some(exported) if exported.atom() == "default")
      }
    }),
    _ => false,
  })
}

impl From<Message> for Diagnostic {
  fn from(value: Message) -> Self {
    let loc = if let Some(place) = value.place {
      Some(match *place {
        Place::Point(point) => SourceLocation {
          start_line: point.line,
          start_col: point.column,
          end_line: point.line,
          end_col: point.column,
        },
        Place::Position(pos) => SourceLocation {
          start_line: pos.start.line,
          start_col: pos.start.column,
          end_line: pos.end.line,
          end_col: pos.end.column,
        },
      })
    } else {
      None
    };

    Diagnostic {
      message: value.reason,
      severity: DiagnosticSeverity::Error,
      hints: None,
      code_highlights: loc.map(|loc| vec![CodeHighlight { message: None, loc }]),
      show_environment: false,
      documentation_url: None,
    }
  }
}
