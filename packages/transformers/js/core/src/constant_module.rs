use std::collections::HashSet;

use swc_core::ecma::{
  ast::{Decl, Expr, Lit, Module, ModuleDecl, ModuleItem, Stmt, VarDeclKind, VarDeclarator},
  atoms::JsWord,
  visit::Visit,
};

fn is_safe_literal(lit: &Lit) -> bool {
  matches!(
    lit,
    Lit::Str(..) | Lit::Bool(..) | Lit::BigInt(..) | Lit::Null(..) | Lit::Num(..)
  )
}

/// Run analysis over a module to return whether it is a 'constant module'. A constant module is one
/// which only consists of constant variable declaration export statements and is safe to inline
/// at its usage site. Declarations are safe if they refer to value type literals (string, bool,
/// null, big-int, numbers, certain template strings).
///
/// For example, this is a constant module:
/// ```skip
/// export const ANGLE = 30;
/// export const COLOR = 'red';
/// ```
///
/// For example, this is not a constant module:
/// ```skip
/// bail-out due to non-decl statement:
/// import {writeFileSync, readFileSync} from 'fs';
///
/// // bail-out due to non-decl statement:
/// writeFileSync('test', 'file');
///
/// // bail-out to non constant declarator RHS (only value type literals are supported):
/// export const COLOR = readFileSync('test');
///
/// ```
pub struct ConstantModule {
  pub is_constant_module: bool,
  constants: HashSet<JsWord>,
}

impl ConstantModule {
  pub fn new() -> Self {
    ConstantModule {
      is_constant_module: true,
      constants: HashSet::new(),
    }
  }

  fn is_constant_declarator(&mut self, decl: &VarDeclarator) -> bool {
    if let Some(init) = &decl.init {
      match &**init {
        Expr::Lit(lit) => is_safe_literal(lit),
        Expr::Tpl(tpl) => {
          for expr in &tpl.exprs {
            match &**expr {
              Expr::Lit(lit) => {
                if !is_safe_literal(lit) {
                  return false;
                }
              }
              Expr::Ident(ident) => {
                if !self.constants.contains(&ident.sym) {
                  return false;
                }
              }
              _ => {
                return false;
              }
            }
          }

          true
        }
        _ => false,
      }
    } else {
      true
    }
  }

  fn is_constant_declaration(&mut self, decl: &Decl) -> bool {
    if let Some(var_decl) = decl.as_var() {
      if !matches!(var_decl.kind, VarDeclKind::Const) {
        return false;
      }

      for declarator in &var_decl.decls {
        if !self.is_constant_declarator(declarator) {
          return false;
        }

        if let Some(ident) = declarator.name.as_ident() {
          self.constants.insert(ident.id.sym.clone());
        } else {
          return false;
        }
      }

      true
    } else {
      false
    }
  }
}

impl Visit for ConstantModule {
  fn visit_module(&mut self, module: &Module) {
    if module.body.is_empty() {
      // Empty modules should not be marked as constant modules
      self.is_constant_module = false;
      return;
    }

    for statement in &module.body {
      match statement {
        ModuleItem::ModuleDecl(module_decl) => match module_decl {
          ModuleDecl::ExportDecl(export_decl) => {
            let result = self.is_constant_declaration(&export_decl.decl);

            if !result {
              self.is_constant_module = false;
              return;
            }
          }
          _ => {
            self.is_constant_module = false;
            return;
          }
        },
        ModuleItem::Stmt(stmt) => match stmt {
          Stmt::Decl(decl) => {
            let result = self.is_constant_declaration(decl);

            if !result {
              self.is_constant_module = false;
              return;
            }
          }
          _ => {
            self.is_constant_module = false;
            return;
          }
        },
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use swc_core::{
    common::{comments::SingleThreadedComments, sync::Lrc, FileName, Globals, SourceMap},
    ecma::{
      parser::{lexer::Lexer, Parser, StringInput},
      visit::VisitWith,
    },
  };

  use super::*;
  extern crate indoc;

  fn is_constant_module(code: &str) -> bool {
    let source_map = Lrc::new(SourceMap::default());
    let source_file = source_map.new_source_file(Lrc::new(FileName::Anon), code.into());

    let comments = SingleThreadedComments::default();
    let lexer = Lexer::new(
      Default::default(),
      Default::default(),
      StringInput::from(&*source_file),
      Some(&comments),
    );

    let mut parser = Parser::new_from(lexer);
    match parser.parse_module() {
      Ok(module) => swc_core::common::GLOBALS.set(&Globals::new(), || {
        swc_core::ecma::transforms::base::helpers::HELPERS.set(
          &swc_core::ecma::transforms::base::helpers::Helpers::new(false),
          || {
            let mut constant_module = ConstantModule::new();
            module.visit_with(&mut constant_module);

            constant_module.is_constant_module
          },
        )
      }),
      Err(err) => {
        panic!("{:?}", err);
      }
    }
  }

  #[test]
  fn string() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = 'Hi';
    "#,
    );

    assert!(result);
  }

  #[test]
  fn null() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = null;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn bool() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = false;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn num() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = 3;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn bigint() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = 3n;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn unexported_consts() {
    let result = is_constant_module(
      r#"
    const local = 'local';
    export const SOMETHING = 'export';
    "#,
    );

    assert!(result);
  }

  #[test]
  fn template_literals() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = `TEST`;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn template_literals_known_var() {
    let result = is_constant_module(
      r#"
    const localVar = 'local';
    export const SOMETHING = `TEST-${localVar}`;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn template_literals_nested_literal() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = `TEST-${'but-why'}`;
    "#,
    );

    assert!(result);
  }

  #[test]
  fn template_literals_unknown_var() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = `TEST-${someVar}`;
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn side_effect() {
    let result = is_constant_module(
      r#"
    sideEffect();
    export const SOMETHING = '';
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn import() {
    let result = is_constant_module(
      r#"
    import {something} from './somewhere';
    export const SOMETHING = '';
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn object() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = {};
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn array() {
    let result = is_constant_module(
      r#"
    export const SOMETHING = [];
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn export_let() {
    let result = is_constant_module(
      r#"
    export let SOMETHING = 'Hi';
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn var() {
    let result = is_constant_module(
      r#"
    export var SOMETHING = 'Hi';
    "#,
    );

    assert!(!result);
  }

  #[test]
  fn empty_file() {
    let result = is_constant_module(r#""#);

    assert!(!result);
  }
}
