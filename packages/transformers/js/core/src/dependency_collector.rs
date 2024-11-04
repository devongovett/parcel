use std::{
  collections::{hash_map::DefaultHasher, HashMap},
  fmt,
  hash::{Hash, Hasher},
  path::Path,
};

use path_slash::PathBufExt;
use serde::{Deserialize, Serialize};
use swc_core::{
  common::{sync::Lrc, Mark, SourceMap, Span, SyntaxContext, DUMMY_SP},
  ecma::{
    ast::{self, Callee, IdentName, MemberProp},
    atoms::{js_word, JsWord},
    utils::stack_size::maybe_grow_default,
    visit::{Fold, FoldWith},
  },
};

use crate::{fold_member_expr_skip_prop, utils::*, Config};

macro_rules! hash {
  ($str:expr) => {{
    let mut hasher = DefaultHasher::new();
    $str.hash(&mut hasher);
    hasher.finish()
  }};
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DependencyKind {
  /// Corresponds to ESM import statements
  /// ```skip
  /// import {x} from './dependency';
  /// ```
  Import,
  /// Corresponds to ESM re-export statements
  /// ```skip
  /// export {x} from './dependency';
  /// ```
  Export,
  /// Corresponds to dynamic import statements
  /// ```skip
  /// import('./dependency').then(({x}) => {/* ... */});
  /// ```
  DynamicImport,
  /// Corresponds to CJS require statements
  /// ```skip
  /// const {x} = require('./dependency');
  /// ```
  Require,
  /// Corresponds to Worker URL statements
  /// ```skip
  /// const worker = new Worker(
  ///     new URL('./dependency', import.meta.url),
  ///     {type: 'module'}
  /// );
  /// ```
  WebWorker,
  /// Corresponds to ServiceWorker URL statements
  /// ```skip
  /// navigator.serviceWorker.register(
  ///     new URL('./dependency', import.meta.url),
  ///     {type: 'module'}
  /// );
  /// ```
  ServiceWorker,
  /// CSS / WebAudio worklets
  /// ```skip
  /// CSS.paintWorklet.addModule(
  ///   new URL('./dependency', import.meta.url)
  /// );
  /// ```
  Worklet,
  /// URL statements
  /// ```skip
  /// let img = document.createElement('img');
  /// img.src = new URL('hero.jpg', import.meta.url);
  /// document.body.appendChild(img);
  /// ```
  Url,
  /// `fs.readFileSync` statements
  ///
  /// > Calls to fs.readFileSync are replaced with the file's contents if the filepath is statically
  /// > determinable and inside the project root.
  ///
  /// ```skip
  /// import fs from "fs";
  /// import path from "path";
  ///
  /// const data = fs.readFileSync(path.join(__dirname, "data.json"), "utf8");
  /// ```
  ///
  /// * https://parceljs.org/features/node-emulation/#inlining-fs.readfilesync
  File,
}

impl fmt::Display for DependencyKind {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    write!(f, "{:?}", self)
  }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct DependencyDescriptor {
  pub kind: DependencyKind,
  pub loc: SourceLocation,
  /// The text specifier associated with the import/export statement.
  pub specifier: swc_core::ecma::atoms::JsWord,
  pub attributes: Option<HashMap<swc_core::ecma::atoms::JsWord, bool>>,
  pub is_optional: bool,
  pub is_helper: bool,
  pub source_type: Option<SourceType>,
  pub placeholder: Option<String>,
}

/// This pass collects dependencies in a module and compiles references as needed to work with Parcel's JSRuntime.
pub fn dependency_collector<'a>(
  source_map: Lrc<SourceMap>,
  items: &'a mut Vec<DependencyDescriptor>,
  ignore_mark: swc_core::common::Mark,
  unresolved_mark: swc_core::common::Mark,
  config: &'a Config,
  diagnostics: &'a mut Vec<Diagnostic>,
) -> impl Fold + 'a {
  DependencyCollector {
    source_map,
    items,
    in_try: false,
    in_promise: false,
    require_node: None,
    ignore_mark,
    unresolved_mark,
    config,
    diagnostics,
    import_meta: None,
  }
}

struct DependencyCollector<'a> {
  source_map: Lrc<SourceMap>,
  items: &'a mut Vec<DependencyDescriptor>,
  in_try: bool,
  in_promise: bool,
  require_node: Option<ast::CallExpr>,
  ignore_mark: swc_core::common::Mark,
  unresolved_mark: swc_core::common::Mark,
  config: &'a Config,
  diagnostics: &'a mut Vec<Diagnostic>,
  import_meta: Option<ast::VarDecl>,
}

impl<'a> DependencyCollector<'a> {
  fn add_dependency(
    &mut self,
    mut specifier: JsWord,
    span: swc_core::common::Span,
    kind: DependencyKind,
    attributes: Option<HashMap<swc_core::ecma::atoms::JsWord, bool>>,
    is_optional: bool,
    source_type: SourceType,
  ) -> Option<JsWord> {
    // Rewrite SWC helpers from ESM to CJS for library output.
    let mut is_specifier_rewritten = false;
    if self.config.is_library && !self.config.is_esm_output {
      if let Some(rest) = specifier.strip_prefix("@swc/helpers/_/") {
        specifier = format!("@swc/helpers/cjs/{}.cjs", rest).into();
        is_specifier_rewritten = true;
      }
    }

    // For ESM imports, the specifier will remain unchanged.
    // For other types of dependencies, the specifier will be changed to a hash
    // that also contains the dependency kind. This way, multiple kinds of dependencies
    // to the same specifier can be used within the same file.
    let placeholder = match kind {
      DependencyKind::Import | DependencyKind::Export => {
        if is_specifier_rewritten {
          Some(specifier.as_ref().to_owned())
        } else {
          None
        }
      }
      _ if !self.config.standalone => Some(format!(
        "{:x}",
        hash!(format!(
          "{}:{}:{}",
          self.get_project_relative_filename(),
          specifier,
          kind
        )),
      )),
      _ => None,
    };

    self.items.push(DependencyDescriptor {
      kind,
      loc: SourceLocation::from(&self.source_map, span),
      specifier,
      attributes,
      is_optional,
      is_helper: span.is_dummy(),
      source_type: Some(source_type),
      placeholder: placeholder.clone(),
    });

    placeholder.map(|p| p.into())
  }

  fn add_url_dependency(
    &mut self,
    specifier: JsWord,
    span: swc_core::common::Span,
    kind: DependencyKind,
    source_type: SourceType,
  ) -> ast::Expr {
    // If not a library, replace with a require call pointing to a runtime that will resolve the url dynamically.
    if !self.config.is_library && !self.config.standalone {
      let placeholder =
        self.add_dependency(specifier.clone(), span, kind, None, false, source_type);
      let specifier = if let Some(placeholder) = placeholder {
        placeholder
      } else {
        specifier
      };
      return ast::Expr::Call(self.create_require(specifier));
    }

    // For library builds, we need to create something that can be statically analyzed by another bundler,
    // so rather than replacing with a require call that is resolved by a runtime, replace with a `new URL`
    // call with a placeholder for the relative path to be replaced during packaging.
    let placeholder = if self.config.standalone {
      specifier.as_ref().into()
    } else {
      format!(
        "{:x}",
        hash!(format!(
          "parcel_url:{}:{}:{}",
          self.config.filename, specifier, kind
        ))
      )
    };
    self.items.push(DependencyDescriptor {
      kind,
      loc: SourceLocation::from(&self.source_map, span),
      specifier,
      attributes: None,
      is_optional: false,
      is_helper: span.is_dummy(),
      source_type: Some(source_type),
      placeholder: Some(placeholder.clone()),
    });

    create_url_constructor(
      ast::Expr::Lit(ast::Lit::Str(placeholder.into())),
      self.config.is_esm_output,
    )
  }

  fn create_require(&mut self, specifier: JsWord) -> ast::CallExpr {
    let mut res = create_require(specifier, self.unresolved_mark);

    // For scripts, we replace with __parcel__require__, which is later replaced
    // by a real parcelRequire of the resolved asset in the packager.
    if self.config.source_type == SourceType::Script {
      res.callee = ast::Callee::Expr(Box::new(ast::Expr::Ident(ast::Ident::new_no_ctxt(
        "__parcel__require__".into(),
        DUMMY_SP,
      ))));
    }
    res
  }

  fn add_script_error(&mut self, span: Span) {
    // Only add the diagnostic for imports/exports in scripts once.
    if self.diagnostics.iter().any(|d| d.message == "SCRIPT_ERROR") {
      return;
    }

    self.diagnostics.push(Diagnostic {
      message: "SCRIPT_ERROR".to_string(),
      code_highlights: Some(vec![CodeHighlight {
        message: None,
        loc: SourceLocation::from(&self.source_map, span),
      }]),
      hints: None,
      show_environment: true,
      severity: DiagnosticSeverity::Error,
      documentation_url: Some(String::from(
        "https://parceljs.org/languages/javascript/#classic-scripts",
      )),
    });
  }
}

fn rewrite_require_specifier(node: ast::CallExpr, unresolved_mark: Mark) -> ast::CallExpr {
  if let Some(arg) = node.args.first() {
    if let Some((value, _)) = match_str(&arg.expr) {
      if value.starts_with("node:") {
        // create_require will take care of replacing the node: prefix...
        return create_require(value, unresolved_mark);
      }
    }
  }
  node
}

impl<'a> Fold for DependencyCollector<'a> {
  fn fold_module(&mut self, node: ast::Module) -> ast::Module {
    let mut res = node.fold_children_with(self);
    if let Some(decl) = self.import_meta.take() {
      res.body.insert(
        0,
        ast::ModuleItem::Stmt(ast::Stmt::Decl(ast::Decl::Var(Box::new(decl)))),
      );
    }
    res
  }

  fn fold_module_decl(&mut self, node: ast::ModuleDecl) -> ast::ModuleDecl {
    // If an import or export is seen within a script, flag it to throw an error from JS.
    if self.config.source_type == SourceType::Script {
      match node {
        ast::ModuleDecl::Import(ast::ImportDecl { span, .. })
        | ast::ModuleDecl::ExportAll(ast::ExportAll { span, .. })
        | ast::ModuleDecl::ExportDecl(ast::ExportDecl { span, .. })
        | ast::ModuleDecl::ExportDefaultDecl(ast::ExportDefaultDecl { span, .. })
        | ast::ModuleDecl::ExportDefaultExpr(ast::ExportDefaultExpr { span, .. })
        | ast::ModuleDecl::ExportNamed(ast::NamedExport { span, .. }) => {
          self.add_script_error(span)
        }
        _ => {}
      }
      return node;
    }

    node.fold_children_with(self)
  }

  fn fold_import_decl(&mut self, mut node: ast::ImportDecl) -> ast::ImportDecl {
    if node.type_only {
      return node;
    }

    let rewritten = self.add_dependency(
      node.src.value.clone(),
      node.src.span,
      DependencyKind::Import,
      None,
      false,
      self.config.source_type,
    );

    if let Some(rewritten) = rewritten {
      node.src.value = rewritten;
    }

    node
  }

  fn fold_named_export(&mut self, mut node: ast::NamedExport) -> ast::NamedExport {
    if let Some(src) = &mut node.src {
      if node.type_only {
        return node;
      }

      let rewritten = self.add_dependency(
        src.value.clone(),
        src.span,
        DependencyKind::Export,
        None,
        false,
        self.config.source_type,
      );

      if let Some(rewritten) = rewritten {
        src.value = rewritten;
      }
    }

    node
  }

  fn fold_export_all(&mut self, mut node: ast::ExportAll) -> ast::ExportAll {
    let rewritten = self.add_dependency(
      node.src.value.clone(),
      node.src.span,
      DependencyKind::Export,
      None,
      false,
      self.config.source_type,
    );

    if let Some(rewritten) = rewritten {
      node.src.value = rewritten;
    }

    node
  }

  fn fold_try_stmt(&mut self, node: ast::TryStmt) -> ast::TryStmt {
    // Track if we're inside a try block to mark dependencies as optional.
    self.in_try = true;
    let block = node.block.fold_with(self);
    self.in_try = false;

    let handler = node.handler.map(|handler| handler.fold_with(self));
    let finalizer = node.finalizer.map(|finalizer| finalizer.fold_with(self));

    ast::TryStmt {
      span: node.span,
      block,
      handler,
      finalizer,
    }
  }

  fn fold_call_expr(&mut self, node: ast::CallExpr) -> ast::CallExpr {
    use ast::Expr::*;

    let kind = match &node.callee {
      Callee::Import(_) => DependencyKind::DynamicImport,
      Callee::Expr(expr) => {
        match &**expr {
          Ident(ident) => {
            // Bail if defined in scope
            if !is_unresolved(&ident, self.unresolved_mark) {
              return node.fold_children_with(self);
            }

            match ident.sym.to_string().as_str() {
              "require" => {
                if self.in_promise {
                  DependencyKind::DynamicImport
                } else {
                  DependencyKind::Require
                }
              }
              "importScripts" => {
                if self.config.is_worker {
                  let (msg, span) = if self.config.source_type == SourceType::Script {
                    // Ignore if argument is not a string literal.
                    let span = if let Some(ast::ExprOrSpread { expr, .. }) = node.args.first() {
                      match &**expr {
                        Lit(ast::Lit::Str(ast::Str { value, span, .. })) => {
                          // Ignore absolute URLs.
                          if value.starts_with("http:")
                            || value.starts_with("https:")
                            || value.starts_with("//")
                          {
                            return node.fold_children_with(self);
                          }
                          span
                        }
                        _ => {
                          return node.fold_children_with(self);
                        }
                      }
                    } else {
                      return node.fold_children_with(self);
                    };

                    (
                      "Argument to importScripts() must be a fully qualified URL.",
                      *span,
                    )
                  } else {
                    (
                      "importScripts() is not supported in module workers.",
                      node.span,
                    )
                  };
                  self.diagnostics.push(Diagnostic {
                    message: msg.to_string(),
                    code_highlights: Some(vec![CodeHighlight {
                      message: None,
                      loc: SourceLocation::from(&self.source_map, span),
                    }]),
                    hints: Some(vec![String::from(
                      "Use a static `import`, or dynamic `import()` instead.",
                    )]),
                    show_environment: self.config.source_type == SourceType::Script,
                    severity: DiagnosticSeverity::Error,
                    documentation_url: Some(String::from(
                      "https://parceljs.org/languages/javascript/#classic-script-workers",
                    )),
                  });
                }

                return node.fold_children_with(self);
              }
              "__parcel__require__" => {
                let mut call = node.fold_children_with(self);
                call.callee = ast::Callee::Expr(Box::new(ast::Expr::Ident(ast::Ident::new(
                  "require".into(),
                  DUMMY_SP,
                  SyntaxContext::empty().apply_mark(self.ignore_mark),
                ))));
                return call;
              }
              "__parcel__import__" => {
                let mut call = node.fold_children_with(self);
                call.callee = ast::Callee::Expr(Box::new(ast::Expr::Ident(ast::Ident::new(
                  "import".into(),
                  DUMMY_SP,
                  SyntaxContext::empty().apply_mark(self.ignore_mark),
                ))));
                return call;
              }
              "__parcel__importScripts__" => {
                let mut call = node.fold_children_with(self);
                call.callee = ast::Callee::Expr(Box::new(ast::Expr::Ident(ast::Ident::new(
                  "importScripts".into(),
                  DUMMY_SP,
                  SyntaxContext::empty().apply_mark(self.ignore_mark),
                ))));
                return call;
              }
              _ => return node.fold_children_with(self),
            }
          }
          Member(member) => {
            if match_member_expr(member, vec!["module", "require"], self.unresolved_mark) {
              DependencyKind::Require
            } else if self.config.is_browser
              && match_member_expr(
                member,
                vec!["navigator", "serviceWorker", "register"],
                self.unresolved_mark,
              )
            {
              DependencyKind::ServiceWorker
            } else if self.config.is_browser
              && match_member_expr(
                member,
                vec!["CSS", "paintWorklet", "addModule"],
                self.unresolved_mark,
              )
            {
              DependencyKind::Worklet
            } else {
              let was_in_promise = self.in_promise;

              // Match compiled dynamic imports (Parcel)
              // Promise.resolve(require('foo'))
              if match_member_expr(member, vec!["Promise", "resolve"], self.unresolved_mark) {
                if let Some(expr) = node.args.first() {
                  if match_require(&expr.expr, self.unresolved_mark, Mark::fresh(Mark::root()))
                    .is_some()
                  {
                    self.in_promise = true;
                    let node = node.fold_children_with(self);
                    self.in_promise = was_in_promise;
                    return node;
                  }
                }
              }

              // Match compiled dynamic imports (TypeScript)
              // Promise.resolve().then(() => require('foo'))
              // Promise.resolve().then(() => { return require('foo') })
              // Promise.resolve().then(function () { return require('foo') })
              //   but not
              // Promise.resolve(require('foo'))
              if let Call(call) = &*member.obj {
                if let Callee::Expr(e) = &call.callee {
                  if let Member(m) = &**e {
                    if match_member_expr(m, vec!["Promise", "resolve"], self.unresolved_mark) &&
                        // Make sure the arglist is empty.
                        // I.e. do not proceed with the below unless Promise.resolve has an empty arglist
                        // because build_promise_chain() will not work in this case.
                        call.args.is_empty()
                    {
                      if let MemberProp::Ident(id) = &member.prop {
                        if id.sym.to_string().as_str() == "then" {
                          if let Some(arg) = node.args.first() {
                            match &*arg.expr {
                              Fn(_) | Arrow(_) => {
                                self.in_promise = true;
                                let node = node.clone().fold_children_with(self);
                                self.in_promise = was_in_promise;

                                // Transform Promise.resolve().then(() => __importStar(require('foo')))
                                //   => Promise.resolve().then(() => require('foo')).then(res => __importStar(res))
                                if let Some(require_node) = self.require_node.clone() {
                                  self.require_node = None;
                                  return build_promise_chain(node, require_node);
                                }
                              }
                              _ => {}
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }

              return node.fold_children_with(self);
            }
          }
          _ => return node.fold_children_with(self),
        }
      }
      _ => return node.fold_children_with(self),
    };

    // Convert import attributes for dynamic import
    let mut attributes = None;
    if kind == DependencyKind::DynamicImport {
      if let Some(arg) = node.args.get(1) {
        if let Object(arg) = &*arg.expr {
          let mut attrs = HashMap::new();
          for key in &arg.props {
            let prop = match key {
              ast::PropOrSpread::Prop(prop) => prop,
              _ => continue,
            };

            let kv = match &**prop {
              ast::Prop::KeyValue(kv) => kv,
              _ => continue,
            };

            let k = match &kv.key {
              ast::PropName::Ident(IdentName { sym, .. })
              | ast::PropName::Str(ast::Str { value: sym, .. }) => sym.clone(),
              _ => continue,
            };

            let v = match &*kv.value {
              Lit(ast::Lit::Bool(ast::Bool { value, .. })) => *value,
              _ => continue,
            };

            attrs.insert(k, v);
          }

          attributes = Some(attrs);
        }
      }
    }

    let node = if let Some(arg) = node.args.first() {
      if kind == DependencyKind::ServiceWorker || kind == DependencyKind::Worklet {
        let (source_type, opts) = if kind == DependencyKind::ServiceWorker {
          match_worker_type(node.args.get(1))
        } else {
          // Worklets are always modules
          (SourceType::Module, None)
        };
        let mut node = node.clone();

        let (specifier, span) = if let Some(s) = self.match_new_url(&arg.expr) {
          s
        } else if let Lit(ast::Lit::Str(str_)) = &*arg.expr {
          let (msg, docs) = if kind == DependencyKind::ServiceWorker {
            (
              "Registering service workers with a string literal is not supported.",
              "https://parceljs.org/languages/javascript/#service-workers",
            )
          } else {
            (
              "Registering worklets with a string literal is not supported.",
              "https://parceljs.org/languages/javascript/#worklets",
            )
          };
          self.diagnostics.push(Diagnostic {
            message: msg.to_string(),
            code_highlights: Some(vec![CodeHighlight {
              message: None,
              loc: SourceLocation::from(&self.source_map, str_.span),
            }]),
            hints: Some(vec![format!(
              "Replace with: new URL('{}', import.meta.url)",
              str_.value,
            )]),
            show_environment: false,
            severity: DiagnosticSeverity::Error,
            documentation_url: Some(String::from(docs)),
          });
          return node;
        } else {
          return node;
        };

        node.args[0].expr = Box::new(self.add_url_dependency(specifier, span, kind, source_type));

        match opts {
          Some(opts) => {
            node.args[1] = opts;
          }
          None => {
            node.args.truncate(1);
          }
        }
        return node;
      }

      if let Some((specifier, span)) = match_str(&arg.expr) {
        // require() calls aren't allowed in scripts, flag as an error.
        if kind == DependencyKind::Require && self.config.source_type == SourceType::Script {
          self.add_script_error(node.span);
          return node;
        }

        let placeholder = self.add_dependency(
          specifier,
          span,
          kind.clone(),
          attributes,
          kind == DependencyKind::Require && self.in_try,
          self.config.source_type,
        );

        if let Some(placeholder) = placeholder {
          let mut node = node.clone();
          node.args[0].expr = Box::new(ast::Expr::Lit(ast::Lit::Str(ast::Str {
            value: placeholder,
            span,
            raw: None,
          })));
          node
        } else {
          node
        }
      } else {
        node
      }
    } else {
      node
    };

    // Replace import() with require()
    if kind == DependencyKind::DynamicImport {
      let mut call = node;
      if !self.config.scope_hoist && !self.config.standalone {
        let name = match &self.config.source_type {
          SourceType::Module => "require",
          SourceType::Script => "__parcel__require__",
        };
        call.callee = ast::Callee::Expr(Box::new(ast::Expr::Ident(ast::Ident::new_no_ctxt(
          name.into(),
          DUMMY_SP,
        ))));
      }

      // Drop import attributes
      call.args.truncate(1);

      // Track the returned require call to be replaced with a promise chain.
      let rewritten_call = rewrite_require_specifier(call, self.unresolved_mark);
      self.require_node = Some(rewritten_call.clone());
      rewritten_call
    } else if kind == DependencyKind::Require {
      // Don't continue traversing so that the `require` isn't replaced with undefined
      rewrite_require_specifier(node, self.unresolved_mark)
    } else {
      node.fold_children_with(self)
    }
  }

  fn fold_unary_expr(&mut self, node: ast::UnaryExpr) -> ast::UnaryExpr {
    // Don't traverse `typeof require` further to not replace `require` with undefined
    if let ast::UnaryExpr {
      op: ast::UnaryOp::TypeOf,
      arg,
      ..
    } = &node
    {
      if let ast::Expr::Ident(ident) = &**arg {
        if ident.sym == js_word!("require") && is_unresolved(&ident, self.unresolved_mark) {
          return node;
        }
      }
    }

    node.fold_children_with(self)
  }

  fn fold_new_expr(&mut self, node: ast::NewExpr) -> ast::NewExpr {
    use ast::Expr::*;

    let matched = match &*node.callee {
      Ident(id) => {
        if id.sym == "Worker" || id.sym == "SharedWorker" {
          // Bail if defined in scope
          self.config.is_browser && is_unresolved(&id, self.unresolved_mark)
        } else if id.sym == "Promise" {
          // Match requires inside promises (e.g. Rollup compiled dynamic imports)
          // new Promise(resolve => resolve(require('foo')))
          // new Promise(resolve => { resolve(require('foo')) })
          // new Promise(function (resolve) { resolve(require('foo')) })
          return self.fold_new_promise(node);
        } else {
          if id.sym == "__parcel__URL__" {
            // new __parcel__URL__(url) -> new URL(url, import.meta.url)
            if let Some(args) = &node.args {
              if let ast::Expr::New(new) = create_url_constructor(
                *args[0].expr.clone().fold_with(self),
                self.config.is_esm_output,
              ) {
                return new;
              }
            }
            unreachable!();
          }
          false
        }
      }
      _ => false,
    };

    if !matched {
      return node.fold_children_with(self);
    }

    if let Some(args) = &node.args {
      if !args.is_empty() {
        let (specifier, span) = if let Some(s) = self.match_new_url(&args[0].expr) {
          s
        } else if let Lit(ast::Lit::Str(str_)) = &*args[0].expr {
          let constructor = match &*node.callee {
            Ident(id) => id.sym.to_string(),
            _ => "Worker".to_string(),
          };
          self.diagnostics.push(Diagnostic {
            message: format!(
              "Constructing a {} with a string literal is not supported.",
              constructor
            ),
            code_highlights: Some(vec![CodeHighlight {
              message: None,
              loc: SourceLocation::from(&self.source_map, str_.span),
            }]),
            hints: Some(vec![format!(
              "Replace with: new URL('{}', import.meta.url)",
              str_.value
            )]),
            show_environment: false,
            severity: DiagnosticSeverity::Error,
            documentation_url: Some(String::from(
              "https://parceljs.org/languages/javascript/#web-workers",
            )),
          });
          return node;
        } else {
          return node;
        };

        let (source_type, opts) = match_worker_type(args.get(1));
        let placeholder =
          self.add_url_dependency(specifier, span, DependencyKind::WebWorker, source_type);

        // Replace argument with a require call to resolve the URL at runtime.
        let mut node = node.clone();
        if let Some(mut args) = node.args.clone() {
          args[0].expr = Box::new(placeholder);

          // If module workers aren't supported natively, remove the `type: 'module'` option.
          // If no other options are passed, remove the argument entirely.
          if !self.config.supports_module_workers {
            match opts {
              None => {
                args.truncate(1);
              }
              Some(opts) => {
                args[1] = opts;
              }
            }
          }
          node.args = Some(args);
        }

        return node;
      }
    }

    node.fold_children_with(self)
  }

  fold_member_expr_skip_prop! {}

  fn fold_expr(&mut self, node: ast::Expr) -> ast::Expr {
    use ast::*;

    if self.is_import_meta(&node) {
      return self.get_import_meta();
    }

    if self.is_import_meta_url(&node) {
      return self.get_import_meta_url();
    }

    if let Some((specifier, span)) = self.match_new_url(&node) {
      let url = self.add_url_dependency(
        specifier,
        span,
        DependencyKind::Url,
        self.config.source_type,
      );

      // If this is a library, we will already have a URL object. Otherwise, we need to
      // construct one from the string returned by the JSRuntime.
      if !self.config.is_library && !self.config.standalone {
        return Expr::New(NewExpr {
          span: DUMMY_SP,
          callee: Box::new(Expr::Ident(Ident::new_no_ctxt(js_word!("URL"), DUMMY_SP))),
          ctxt: SyntaxContext::empty(),
          args: Some(vec![ExprOrSpread {
            expr: Box::new(url),
            spread: None,
          }]),
          type_args: None,
        });
      }

      return url;
    }

    let is_require = match &node {
      Expr::Ident(ident) => {
        // Free `require` -> undefined
        ident.sym == js_word!("require") && is_unresolved(&ident, self.unresolved_mark)
      }
      Expr::Member(MemberExpr { obj: expr, .. }) => {
        // e.g. `require.extensions` -> undefined
        if let Expr::Ident(ident) = &**expr {
          ident.sym == js_word!("require") && is_unresolved(&ident, self.unresolved_mark)
        } else {
          false
        }
      }
      _ => false,
    };

    if is_require {
      return ast::Expr::Ident(get_undefined_ident(self.unresolved_mark));
    }

    maybe_grow_default(|| node.fold_children_with(self))
  }
}

impl<'a> DependencyCollector<'a> {
  fn fold_new_promise(&mut self, node: ast::NewExpr) -> ast::NewExpr {
    use ast::Expr::*;

    // Match requires inside promises (e.g. Rollup compiled dynamic imports)
    // new Promise(resolve => resolve(require('foo')))
    // new Promise(resolve => { resolve(require('foo')) })
    // new Promise(function (resolve) { resolve(require('foo')) })
    // new Promise(function (resolve) { return resolve(require('foo')) })
    if let Some(args) = &node.args {
      if let Some(arg) = args.first() {
        let (resolve, expr) = match &*arg.expr {
          Fn(f) => {
            let param = f.function.params.first().map(|param| &param.pat);
            let body = if let Some(body) = &f.function.body {
              self.match_block_stmt_expr(body)
            } else {
              None
            };
            (param, body)
          }
          Arrow(f) => {
            let param = f.params.first();
            let body = match &*f.body {
              ast::BlockStmtOrExpr::Expr(expr) => Some(&**expr),
              ast::BlockStmtOrExpr::BlockStmt(block) => self.match_block_stmt_expr(block),
            };
            (param, body)
          }
          _ => (None, None),
        };

        let resolve_id = match resolve {
          Some(ast::Pat::Ident(id)) => id.to_id(),
          _ => return node.fold_children_with(self),
        };

        if let Some(ast::Expr::Call(call)) = expr {
          if let ast::Callee::Expr(callee) = &call.callee {
            if let ast::Expr::Ident(id) = &**callee {
              if id.to_id() == resolve_id {
                if let Some(arg) = call.args.first() {
                  if match_require(&arg.expr, self.unresolved_mark, Mark::fresh(Mark::root()))
                    .is_some()
                  {
                    let was_in_promise = self.in_promise;
                    self.in_promise = true;
                    let node = node.fold_children_with(self);
                    self.in_promise = was_in_promise;
                    return node;
                  }
                }
              }
            }
          }
        }
      }
    }

    node.fold_children_with(self)
  }

  fn match_block_stmt_expr<'x>(&self, block: &'x ast::BlockStmt) -> Option<&'x ast::Expr> {
    match block.stmts.last() {
      Some(ast::Stmt::Expr(ast::ExprStmt { expr, .. })) => Some(&**expr),
      Some(ast::Stmt::Return(ast::ReturnStmt { arg, .. })) => {
        if let Some(arg) = arg {
          Some(&**arg)
        } else {
          None
        }
      }
      _ => None,
    }
  }
}

// If the `require` call is not immediately returned (e.g. wrapped in another function),
// then transform the AST to create a promise chain so that the require is by itself.
// This is because the require will return a promise rather than the module synchronously.
// For example, TypeScript generates the following with the esModuleInterop flag:
//   Promise.resolve().then(() => __importStar(require('./foo')));
// This is transformed into:
//   Promise.resolve().then(() => require('./foo')).then(res => __importStar(res));
fn build_promise_chain(node: ast::CallExpr, require_node: ast::CallExpr) -> ast::CallExpr {
  let mut transformer = PromiseTransformer {
    require_node: Some(require_node),
  };

  let node = node.fold_with(&mut transformer);

  if let Some(require_node) = &transformer.require_node {
    if let Some(f) = node.args.first() {
      // Add `res` as an argument to the original function
      let f = match &*f.expr {
        ast::Expr::Fn(f) => {
          let mut f = f.clone();
          f.function.params.insert(
            0,
            ast::Param {
              pat: ast::Pat::Ident(ast::BindingIdent::from(ast::Ident::new_no_ctxt(
                "res".into(),
                DUMMY_SP,
              ))),
              decorators: vec![],
              span: DUMMY_SP,
            },
          );
          ast::Expr::Fn(f)
        }
        ast::Expr::Arrow(f) => {
          let mut f = f.clone();
          f.params.insert(
            0,
            ast::Pat::Ident(ast::BindingIdent::from(ast::Ident::new_no_ctxt(
              "res".into(),
              DUMMY_SP,
            ))),
          );
          ast::Expr::Arrow(f)
        }
        _ => return node,
      };

      return ast::CallExpr {
        callee: ast::Callee::Expr(Box::new(ast::Expr::Member(ast::MemberExpr {
          span: DUMMY_SP,
          obj: (Box::new(ast::Expr::Call(ast::CallExpr {
            callee: node.callee,
            args: vec![ast::ExprOrSpread {
              expr: Box::new(ast::Expr::Fn(ast::FnExpr {
                ident: None,
                function: Box::new(ast::Function {
                  body: Some(ast::BlockStmt {
                    span: DUMMY_SP,
                    stmts: vec![ast::Stmt::Return(ast::ReturnStmt {
                      span: DUMMY_SP,
                      arg: Some(Box::new(ast::Expr::Call(require_node.clone()))),
                    })],
                    ctxt: SyntaxContext::empty(),
                  }),
                  params: vec![],
                  decorators: vec![],
                  is_async: false,
                  is_generator: false,
                  return_type: None,
                  type_params: None,
                  span: DUMMY_SP,
                  ctxt: SyntaxContext::empty(),
                }),
              })),
              spread: None,
            }],
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            type_args: None,
          }))),
          prop: MemberProp::Ident(ast::IdentName::new("then".into(), DUMMY_SP)),
        }))),
        args: vec![ast::ExprOrSpread {
          expr: Box::new(f),
          spread: None,
        }],
        span: DUMMY_SP,
        ctxt: SyntaxContext::empty(),
        type_args: None,
      };
    }
  }

  node
}

fn create_url_constructor(url: ast::Expr, use_import_meta: bool) -> ast::Expr {
  use ast::*;

  let expr = if use_import_meta {
    Expr::Member(MemberExpr {
      span: DUMMY_SP,
      obj: Box::new(Expr::MetaProp(MetaPropExpr {
        kind: MetaPropKind::ImportMeta,
        span: DUMMY_SP,
      })),
      prop: MemberProp::Ident(IdentName::new(js_word!("url"), DUMMY_SP)),
    })
  } else {
    // CJS output: "file:" + __filename
    Expr::Bin(BinExpr {
      span: DUMMY_SP,
      left: Box::new(Expr::Lit(Lit::Str("file:".into()))),
      op: BinaryOp::Add,
      right: Box::new(Expr::Ident(Ident::new_no_ctxt(
        "__filename".into(),
        DUMMY_SP,
      ))),
    })
  };

  Expr::New(NewExpr {
    span: DUMMY_SP,
    ctxt: SyntaxContext::empty(),
    callee: Box::new(Expr::Ident(Ident::new_no_ctxt(js_word!("URL"), DUMMY_SP))),
    args: Some(vec![
      ExprOrSpread {
        expr: Box::new(url),
        spread: None,
      },
      ExprOrSpread {
        expr: Box::new(expr),
        spread: None,
      },
    ]),
    type_args: None,
  })
}

struct PromiseTransformer {
  require_node: Option<ast::CallExpr>,
}

impl Fold for PromiseTransformer {
  fn fold_return_stmt(&mut self, node: ast::ReturnStmt) -> ast::ReturnStmt {
    // If the require node is returned, no need to do any replacement.
    if let Some(arg) = &node.arg {
      if let ast::Expr::Call(call) = &**arg {
        if let Some(require_node) = &self.require_node {
          if require_node == call {
            self.require_node = None
          }
        }
      }
    }

    node.fold_children_with(self)
  }

  fn fold_arrow_expr(&mut self, node: ast::ArrowExpr) -> ast::ArrowExpr {
    if let ast::BlockStmtOrExpr::Expr(expr) = &*node.body {
      if let ast::Expr::Call(call) = &**expr {
        if let Some(require_node) = &self.require_node {
          if require_node == call {
            self.require_node = None
          }
        }
      }
    }

    node.fold_children_with(self)
  }

  fn fold_expr(&mut self, node: ast::Expr) -> ast::Expr {
    let node = node.fold_children_with(self);

    // Replace the original require node with a reference to a variable `res`,
    // which will be added as a parameter to the parent function.
    if let ast::Expr::Call(call) = &node {
      if let Some(require_node) = &self.require_node {
        if require_node == call {
          return ast::Expr::Ident(ast::Ident::new_no_ctxt("res".into(), DUMMY_SP));
        }
      }
    }

    node
  }
}

impl<'a> DependencyCollector<'a> {
  fn match_new_url(&mut self, expr: &ast::Expr) -> Option<(JsWord, swc_core::common::Span)> {
    use ast::*;

    if let Expr::New(new) = expr {
      let is_url = match &*new.callee {
        Expr::Ident(id) => id.sym == js_word!("URL") && is_unresolved(&id, self.unresolved_mark),
        _ => false,
      };

      if !is_url {
        return None;
      }

      if let Some(args) = &new.args {
        let (specifier, span) = if let Some(arg) = args.first() {
          match_str(&arg.expr)?
        } else {
          return None;
        };

        if let Some(arg) = args.get(1) {
          if self.is_import_meta_url(&arg.expr) {
            return Some((specifier, span));
          }
        }
      }
    }

    // self reference, e.g. new Worker(import.meta.url)
    if self.is_import_meta_url(expr) {
      let filename = Path::new(&self.config.filename).file_name().unwrap();
      let specifier = format!("./{}", filename.to_string_lossy());
      let span = match expr {
        Expr::Member(member) => member.span,
        _ => unreachable!(),
      };
      return Some((specifier.into(), span));
    }

    None
  }

  #[allow(clippy::wrong_self_convention)]
  fn is_import_meta_url(&mut self, expr: &ast::Expr) -> bool {
    use ast::*;

    match expr {
      Expr::Member(member) => {
        if !self.is_import_meta(&member.obj) {
          return false;
        }

        let name = match_property_name(member);

        if let Some((name, _)) = name {
          name == js_word!("url")
        } else {
          false
        }
      }
      Expr::Bin(BinExpr {
        op: BinaryOp::Add,
        left,
        right,
        ..
      }) => {
        // Match "file:" + __filename
        let left = match_str(left);
        match (left, &**right) {
          (Some((left, _)), Expr::Ident(Ident { sym: right, .. })) => {
            &left == "file:" && right == "__filename"
          }
          _ => false,
        }
      }
      _ => false,
    }
  }

  #[allow(clippy::wrong_self_convention)]
  fn is_import_meta(&mut self, expr: &ast::Expr) -> bool {
    use ast::*;

    match &expr {
      ast::Expr::MetaProp(MetaPropExpr {
        kind: MetaPropKind::ImportMeta,
        span,
      }) => {
        if self.config.source_type == SourceType::Script {
          self.diagnostics.push(Diagnostic {
            message: "`import.meta` is not supported outside a module.".to_string(),
            code_highlights: Some(vec![CodeHighlight {
              message: None,
              loc: SourceLocation::from(&self.source_map, *span),
            }]),
            hints: None,
            show_environment: true,
            severity: DiagnosticSeverity::Error,
            documentation_url: Some(String::from(
              "https://parceljs.org/languages/javascript/#classic-scripts",
            )),
          })
        }
        true
      }
      _ => false,
    }
  }

  fn get_project_relative_filename(&self) -> String {
    if let Some(relative) = pathdiff::diff_paths(&self.config.filename, &self.config.project_root) {
      relative.to_slash_lossy()
    } else if let Some(filename) = Path::new(&self.config.filename).file_name() {
      String::from(filename.to_string_lossy())
    } else {
      String::from("unknown.js")
    }
  }

  fn get_import_meta_url(&mut self) -> ast::Expr {
    use ast::*;

    Expr::Lit(Lit::Str(
      format!("file:///{}", self.get_project_relative_filename()).into(),
    ))
  }

  fn get_import_meta(&mut self) -> ast::Expr {
    use ast::*;

    if let Some(decl) = &self.import_meta {
      if let Pat::Ident(name) = &decl.decls[0].name {
        Expr::Ident(name.id.clone())
      } else {
        unreachable!()
      }
    } else {
      // Declares a variable at the top of the module:
      // var import_meta = Object.assign(Object.create(null), {url: 'file:///src/foo.js'});
      let ident = Ident::new_private(
        format!("${}$import_meta", self.config.module_id).into(),
        DUMMY_SP,
      );
      self.import_meta = Some(VarDecl {
        kind: VarDeclKind::Var,
        declare: false,
        span: DUMMY_SP,
        decls: vec![VarDeclarator {
          name: Pat::Ident(BindingIdent::from(ident.clone())),
          init: Some(Box::new(Expr::Call(CallExpr {
            callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
              obj: Box::new(Expr::Ident(Ident::new_no_ctxt(
                js_word!("Object"),
                DUMMY_SP,
              ))),
              prop: MemberProp::Ident(IdentName::new("assign".into(), DUMMY_SP)),
              span: DUMMY_SP,
            }))),
            args: vec![
              ExprOrSpread {
                expr: Box::new(Expr::Call(CallExpr {
                  callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
                    obj: (Box::new(Expr::Ident(Ident::new_no_ctxt(
                      js_word!("Object"),
                      DUMMY_SP,
                    )))),
                    prop: MemberProp::Ident(IdentName::new("create".into(), DUMMY_SP)),
                    span: DUMMY_SP,
                  }))),
                  args: vec![ExprOrSpread {
                    expr: Box::new(Expr::Lit(Lit::Null(Null { span: DUMMY_SP }))),
                    spread: None,
                  }],
                  span: DUMMY_SP,
                  ctxt: SyntaxContext::empty(),
                  type_args: None,
                })),
                spread: None,
              },
              ExprOrSpread {
                expr: Box::new(Expr::Object(ObjectLit {
                  props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                    key: PropName::Ident(IdentName::new(js_word!("url"), DUMMY_SP)),
                    value: Box::new(self.get_import_meta_url()),
                  })))],
                  span: DUMMY_SP,
                })),
                spread: None,
              },
            ],
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            type_args: None,
          }))),
          span: DUMMY_SP,
          definite: false,
        }],
        ctxt: SyntaxContext::empty(),
      });
      Expr::Ident(ident)
    }
  }
}

// matches the `type: 'module'` option of workers
fn match_worker_type(expr: Option<&ast::ExprOrSpread>) -> (SourceType, Option<ast::ExprOrSpread>) {
  use ast::*;

  if let Some(expr_or_spread) = expr {
    if let Expr::Object(obj) = &*expr_or_spread.expr {
      let mut source_type: Option<SourceType> = None;
      let props: Vec<PropOrSpread> = obj
        .props
        .iter()
        .filter(|key| {
          let prop = match key {
            PropOrSpread::Prop(prop) => prop,
            _ => return true,
          };

          let kv = match &**prop {
            Prop::KeyValue(kv) => kv,
            _ => return true,
          };

          match &kv.key {
            PropName::Ident(IdentName { sym, .. }) if sym == "type" => {}
            PropName::Str(Str { value, .. }) if value == "type" => {}
            _ => return true,
          };

          let v = if let Some((v, _)) = match_str(&kv.value) {
            v
          } else {
            return true;
          };

          source_type = Some(if v == "module" {
            SourceType::Module
          } else {
            SourceType::Script
          });

          false
        })
        .cloned()
        .collect();

      if let Some(source_type) = source_type {
        let e = if props.is_empty() {
          None
        } else {
          Some(ExprOrSpread {
            spread: None,
            expr: Box::new(Expr::Object(ObjectLit {
              props,
              span: obj.span,
            })),
          })
        };

        return (source_type, e);
      }
    }
  }

  (SourceType::Script, expr.cloned())
}

#[cfg(test)]
mod test {
  use super::*;
  use crate::{
    test_utils::{run_fold, RunTestContext, RunVisitResult},
    DependencyDescriptor,
  };

  fn make_dependency_collector<'a>(
    context: RunTestContext,
    items: &'a mut Vec<DependencyDescriptor>,
    diagnostics: &'a mut Vec<Diagnostic>,
    config: &'a Config,
  ) -> DependencyCollector<'a> {
    DependencyCollector {
      source_map: context.source_map.clone(),
      items,
      in_try: false,
      in_promise: false,
      require_node: None,
      ignore_mark: Mark::new(),
      unresolved_mark: context.unresolved_mark,
      config,
      diagnostics,
      import_meta: None,
    }
  }

  fn make_config() -> Config {
    let mut config = Config::default();
    config.is_browser = true;
    config
  }

  fn make_placeholder_hash(specifier: &str, dependency_kind: DependencyKind) -> String {
    format!(
      "{:x}",
      hash!(format!("{}:{}:{}", "", specifier, dependency_kind))
    )
  }

  #[test]
  fn test_dynamic_import_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = Config::default();
    let input_code = r#"
      const { x } = await import('other');
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
      const {{ x }} = await require("{}");
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_import_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = Config::default();
    let input_code = r#"
      import { x } from 'other';
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let expected_code = r#"
      import { x } from 'other';
    "#
    .trim_start()
    .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Import,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: None,
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_export_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = Config::default();
    let input_code = r#"
      export { x } from 'other';
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let expected_code = r#"
      export { x } from 'other';
    "#
    .trim_start()
    .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Export,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: None,
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_export_star_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = Config::default();
    let input_code = r#"
      export * from 'other';
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let expected_code = r#"
      export * from 'other';
    "#
    .trim_start()
    .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Export,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: None,
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_require_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
      const { x } = require('other');
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::Require);
    let expected_code = format!(
      r#"
      const {{ x }} = require("{}");
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Require,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_optional_require_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
try {
    const { x } = require('other');
} catch (err) {}
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::Require);
    let expected_code = format!(
      r#"
try {{
    const {{ x }} = require("{}");
}} catch (err) {{}}
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Require,
        specifier: "other".into(),
        attributes: None,
        is_optional: true,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  // Require is treated as dynamic import
  #[test]
  fn test_compiled_dynamic_imports() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
Promise.resolve().then(() => require('other'));
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
Promise.resolve().then(()=>require("{}"));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  // Require is treated as dynamic import
  #[test]
  fn test_compiled_dynamic_imports_with_chain() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
Promise.resolve().then(() => doSomething(require('other')));
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
Promise.resolve().then(function() {{
    return require("{}");
}}).then((res)=>doSomething(res));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  // Require is treated as dynamic import
  #[test]
  fn test_compiled_dynamic_imports_with_function_chain() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
Promise.resolve().then(function() { return doSomething(require('other')); });
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
Promise.resolve().then(function() {{
    return require("{}");
}}).then(function(res) {{
    return doSomething(res);
}});
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  // Require is treated as dynamic import
  #[test]
  fn test_new_promise_require_imports() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
new Promise((resolve) => resolve(require("other")));
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
new Promise((resolve)=>resolve(require("{}")));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  // Require is treated as dynamic import
  #[test]
  fn test_new_promise_require_imports_with_function_expr() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
new Promise(function(resolve) { return resolve(require("other")) });
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
new Promise(function(resolve) {{
    return resolve(require("{}"));
}});
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  // Require is treated as dynamic import
  #[test]
  fn test_promise_resolve_require_dynamic_import() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
Promise.resolve(require("other"));
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::DynamicImport);
    let expected_code = format!(
      r#"
Promise.resolve(require("{}"));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::DynamicImport,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_worker_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
      new Worker(new URL('other', import.meta.url), {type: 'module'});
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::WebWorker);
    let expected_code = format!(
      r#"
      new Worker(require("{}"));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::WebWorker,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_service_worker_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
      navigator.serviceWorker.register(new URL('other', import.meta.url), {type: 'module'});
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::ServiceWorker);
    let expected_code = format!(
      r#"
      navigator.serviceWorker.register(require("{}"));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::ServiceWorker,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_worklet_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
      CSS.paintWorklet.addModule(new URL('other', import.meta.url));
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("other", DependencyKind::Worklet);
    let expected_code = format!(
      r#"
      CSS.paintWorklet.addModule(require("{}"));
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Worklet,
        specifier: "other".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }

  #[test]
  fn test_url_dependency() {
    let mut items = vec![];
    let mut diagnostics = vec![];
    let config = make_config();
    let input_code = r#"
let img = document.createElement('img');
img.src = new URL('hero.jpg', import.meta.url);
document.body.appendChild(img);
    "#;

    let RunVisitResult { output_code, .. } = run_fold(input_code, |context| {
      make_dependency_collector(context, &mut items, &mut diagnostics, &config)
    });

    let hash = make_placeholder_hash("hero.jpg", DependencyKind::Url);
    let expected_code = format!(
      r#"
let img = document.createElement('img');
img.src = new URL(require("{}"));
document.body.appendChild(img);
    "#,
      hash
    );
    let expected_code = expected_code
      .trim_start()
      .trim_end_matches(|p: char| p == ' ');

    assert_eq!(output_code, expected_code);
    assert_eq!(diagnostics, []);
    assert_eq!(
      items,
      [DependencyDescriptor {
        kind: DependencyKind::Url,
        specifier: "hero.jpg".into(),
        attributes: None,
        is_optional: false,
        is_helper: false,
        source_type: Some(SourceType::Module),
        placeholder: Some(hash),
        ..items[0].clone()
      }]
    );
  }
}
