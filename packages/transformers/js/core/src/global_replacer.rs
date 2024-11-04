use std::path::Path;

use indexmap::IndexMap;
use path_slash::PathBufExt;
use swc_core::{
  common::{sync::Lrc, Mark, SourceMap, SyntaxContext, DUMMY_SP},
  ecma::{
    ast::{self, ComputedPropName, Expr, Module},
    atoms::{js_word, JsWord},
    visit::{VisitMut, VisitMutWith},
  },
};

use crate::{
  dependency_collector::{DependencyDescriptor, DependencyKind},
  utils::{create_global_decl_stmt, create_require, is_unresolved, SourceLocation, SourceType},
};

/// Replaces a few node.js constants with literals or require statements.
/// This duplicates some logic in [`NodeReplacer`]
///
/// (TODO: why is this needed?).
///
/// In particular, the following constants are replaced:
///
/// * `process` - Replaced with a dependency to a magic 'process' module
/// * `Buffer` - Replaced with a dependency to a magic 'buffer' module
/// * `__dirname` and `__filename` - Replaced with the file path
/// * `global` - Replaced with `arguments[3]`.
///
/// Instead of being replaced in-place the identifiers are left in their
/// location, but a declaration statement is added for the identifier at
/// the top of the module.
///
/// For example if a module contains:
/// ```skip
/// function test() {
///     console.log(process);
/// }
/// ```
///
/// It should be converted into:
/// ```skip
/// const process = require('process');
/// function test() {
///     console.log(process);
/// }
/// ```
pub struct GlobalReplacer<'a> {
  pub source_map: Lrc<SourceMap>,
  /// Require statements that are inserted into the file will be added to this list.
  pub items: &'a mut Vec<DependencyDescriptor>,
  pub global_mark: Mark,
  /// Internal structure for inserted global statements.
  pub globals: IndexMap<JsWord, (SyntaxContext, ast::Stmt)>,
  pub project_root: &'a Path,
  pub filename: &'a Path,
  pub unresolved_mark: Mark,
  pub scope_hoist: bool,
}

impl VisitMut for GlobalReplacer<'_> {
  fn visit_mut_expr(&mut self, node: &mut Expr) {
    use ast::{Expr::*, MemberExpr, MemberProp};

    let Ident(id) = node else {
      node.visit_mut_children_with(self);
      return;
    };

    // Only handle global variables
    if !is_unresolved(&id, self.unresolved_mark) {
      return;
    }

    let unresolved_mark = self.unresolved_mark;
    match id.sym.to_string().as_str() {
      "process" => {
        if self.update_binding(id, |_| {
          Call(create_require(js_word!("process"), unresolved_mark))
        }) {
          let specifier = id.sym.clone();
          self.items.push(DependencyDescriptor {
            kind: DependencyKind::Require,
            loc: SourceLocation::from(&self.source_map, id.span),
            specifier,
            attributes: None,
            is_optional: false,
            is_helper: false,
            source_type: Some(SourceType::Module),
            placeholder: None,
          });
        }
      }
      "Buffer" => {
        let specifier = swc_core::ecma::atoms::JsWord::from("buffer");
        if self.update_binding(id, |_| {
          Member(MemberExpr {
            obj: Box::new(Call(create_require(specifier.clone(), unresolved_mark))),
            prop: MemberProp::Ident(ast::IdentName::new("Buffer".into(), DUMMY_SP)),
            span: DUMMY_SP,
          })
        }) {
          self.items.push(DependencyDescriptor {
            kind: DependencyKind::Require,
            loc: SourceLocation::from(&self.source_map, id.span),
            specifier,
            attributes: None,
            is_optional: false,
            is_helper: false,
            source_type: Some(SourceType::Module),
            placeholder: None,
          });
        }
      }
      "__filename" => {
        self.update_binding(id, |this| {
          let filename =
            if let Some(relative) = pathdiff::diff_paths(this.filename, this.project_root) {
              relative.to_slash_lossy()
            } else if let Some(filename) = this.filename.file_name() {
              format!("/{}", filename.to_string_lossy())
            } else {
              String::from("/unknown.js")
            };

          Lit(ast::Lit::Str(
            swc_core::ecma::atoms::JsWord::from(filename).into(),
          ))
        });
      }
      "__dirname" => {
        self.update_binding(id, |this| {
          let dirname = if let Some(dirname) = this.filename.parent() {
            if let Some(relative) = pathdiff::diff_paths(dirname, this.project_root) {
              relative.to_slash_lossy()
            } else {
              String::from("/")
            }
          } else {
            String::from("/")
          };
          Lit(ast::Lit::Str(
            swc_core::ecma::atoms::JsWord::from(dirname).into(),
          ))
        });
      }
      "global" => {
        if !self.scope_hoist {
          self.update_binding(id, |_| {
            Member(MemberExpr {
              obj: Box::new(Ident(ast::Ident::new_no_ctxt(
                js_word!("arguments"),
                DUMMY_SP,
              ))),
              prop: MemberProp::Computed(ComputedPropName {
                span: DUMMY_SP,
                expr: Box::new(Lit(ast::Lit::Num(3.into()))),
              }),
              span: DUMMY_SP,
            })
          });
        }
      }
      _ => {}
    }
  }

  fn visit_mut_module(&mut self, node: &mut Module) {
    node.visit_mut_children_with(self);
    node.body.splice(
      0..0,
      self
        .globals
        .values()
        .map(|(_, stmt)| ast::ModuleItem::Stmt(stmt.clone())),
    );
  }
}

impl GlobalReplacer<'_> {
  fn update_binding<F>(&mut self, id: &mut ast::Ident, expr: F) -> bool
  where
    F: FnOnce(&Self) -> Expr,
  {
    if let Some((syntax_context, _)) = self.globals.get(&id.sym) {
      id.ctxt = *syntax_context;
      false
    } else {
      let (decl, syntax_context) =
        create_global_decl_stmt(id.sym.clone(), expr(self), self.global_mark);

      id.ctxt = syntax_context;

      self.globals.insert(id.sym.clone(), (syntax_context, decl));

      true
    }
  }
}

#[cfg(test)]
mod test {
  use std::path::Path;

  use swc_core::ecma::atoms::JsWord;

  use crate::{
    global_replacer::GlobalReplacer,
    test_utils::{run_visit, RunTestContext, RunVisitResult},
    DependencyDescriptor, DependencyKind,
  };

  fn make_global_replacer(
    run_test_context: RunTestContext,
    items: &mut Vec<DependencyDescriptor>,
  ) -> GlobalReplacer {
    GlobalReplacer {
      source_map: run_test_context.source_map.clone(),
      items,
      global_mark: run_test_context.global_mark.clone(),
      globals: Default::default(),
      project_root: Path::new("project-root"),
      filename: Path::new("filename"),
      unresolved_mark: run_test_context.unresolved_mark.clone(),
      scope_hoist: false,
    }
  }

  #[test]
  fn test_globals_visitor_with_require_process() {
    let mut items = vec![];

    let RunVisitResult { output_code, .. } = run_visit(
      r#"
console.log(process.test);
    "#,
      |run_test_context: RunTestContext| make_global_replacer(run_test_context, &mut items),
    );
    assert_eq!(
      output_code,
      r#"var process = require("process");
console.log(process.test);
"#
    );
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, DependencyKind::Require);
    assert_eq!(items[0].specifier, JsWord::from("process"));
  }

  #[test]
  fn test_transforms_computed_property() {
    let mut items = vec![];

    let RunVisitResult { output_code, .. } = run_visit(
      r#"
object[process.test];
object[__dirname];
    "#,
      |run_test_context: RunTestContext| make_global_replacer(run_test_context, &mut items),
    );
    assert_eq!(
      output_code,
      r#"var process = require("process");
var __dirname = "..";
object[process.test];
object[__dirname];
"#
    );
  }

  #[test]
  fn test_does_not_transform_member_property() {
    let mut items = vec![];

    let RunVisitResult { output_code, .. } = run_visit(
      r#"
object.process.test;
object.__filename;
    "#,
      |run_test_context: RunTestContext| make_global_replacer(run_test_context, &mut items),
    );
    assert_eq!(
      output_code,
      r#"object.process.test;
object.__filename;
"#
    );
  }
}
