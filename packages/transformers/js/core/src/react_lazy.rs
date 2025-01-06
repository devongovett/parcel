use swc_core::{
  common::DUMMY_SP,
  ecma::{
    ast::{
      ArrowExpr, BindingIdent, BlockStmt, BlockStmtOrExpr, CallExpr, Callee, ComputedPropName,
      Decl, Expr, ExprOrSpread, ExprStmt, FnDecl, Function, Ident, IdentName, KeyValueProp,
      MemberExpr, MemberProp, Module, ModuleItem, ObjectLit, Param, Pat, Prop, PropName,
      PropOrSpread, ReturnStmt, Stmt, VarDecl, VarDeclarator,
    },
    utils::member_expr,
    visit::{VisitMut, VisitMutWith},
  },
};

use crate::collect::Collect;

/// This pass rewrites React.lazy to attach a resources property so
/// that CSS can be injected into the RSC stream.
///
/// Example:
///
/// let Lazy = React.lazy(() => import('./foo'));
///
/// compiles to:
///
/// function lazy(cb) {
///   let Lazy = React.lazy(cb);
///   let resources = Symbol.for('react.resources');
///   Object.defineProperty(Lazy, resources, {get: () => cb()[resources] });
///   return Lazy;
/// }
pub struct ReactLazy<'a> {
  collect: &'a Collect,
  lazy: Option<(Ident, Callee)>,
}

impl<'a> ReactLazy<'a> {
  pub fn new(collect: &'a Collect) -> Self {
    ReactLazy {
      collect,
      lazy: None,
    }
  }
}

impl<'a> VisitMut for ReactLazy<'a> {
  fn visit_mut_module(&mut self, node: &mut Module) {
    node.visit_mut_children_with(self);

    if let Some((helper, react_lazy)) = &self.lazy {
      let cb = Ident::new_private("cb".into(), DUMMY_SP);
      let lazy = Ident::new_private("Lazy".into(), DUMMY_SP);
      let resources = Ident::new_private("resources".into(), DUMMY_SP);
      node.body.push(ModuleItem::Stmt(Stmt::Decl(Decl::Fn(FnDecl {
        declare: false,
        function: Box::new(Function {
          params: vec![Param {
            decorators: vec![],
            pat: Pat::Ident(BindingIdent {
              id: cb.clone(),
              type_ann: None,
            }),
            span: DUMMY_SP,
          }],
          body: Some(BlockStmt {
            stmts: vec![
              Stmt::Decl(Decl::Var(Box::new(VarDecl {
                decls: vec![
                  VarDeclarator {
                    definite: false,
                    init: Some(Box::new(Expr::Call(CallExpr {
                      callee: react_lazy.clone(),
                      args: vec![ExprOrSpread {
                        expr: Box::new(Expr::Ident(cb.clone())),
                        spread: None,
                      }],
                      ..Default::default()
                    }))),
                    name: Pat::Ident(BindingIdent {
                      id: lazy.clone(),
                      type_ann: None,
                    }),
                    span: DUMMY_SP,
                  },
                  VarDeclarator {
                    definite: false,
                    init: Some(Box::new(Expr::Call(CallExpr {
                      callee: Callee::Expr(Box::new(Expr::Member(
                        member_expr!(Default::default(), DUMMY_SP, Symbol.for),
                      ))),
                      args: vec![ExprOrSpread {
                        expr: Box::new("react.resources".into()),
                        spread: None,
                      }],
                      ..Default::default()
                    }))),
                    name: Pat::Ident(BindingIdent {
                      id: resources.clone(),
                      type_ann: None,
                    }),
                    span: DUMMY_SP,
                  },
                ],
                ..Default::default()
              }))),
              Stmt::Expr(ExprStmt {
                expr: Box::new(Expr::Call(CallExpr {
                  callee: Callee::Expr(Box::new(Expr::Member(member_expr!(
                    Default::default(),
                    DUMMY_SP,
                    Object.defineProperty
                  )))),
                  args: vec![
                    ExprOrSpread {
                      expr: Box::new(Expr::Ident(lazy.clone())),
                      spread: None,
                    },
                    ExprOrSpread {
                      expr: Box::new(Expr::Ident(resources.clone())),
                      spread: None,
                    },
                    ExprOrSpread {
                      expr: Box::new(Expr::Object(ObjectLit {
                        props: vec![PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                          key: PropName::Ident(IdentName::new("get".into(), DUMMY_SP)),
                          value: Box::new(Expr::Arrow(ArrowExpr {
                            body: Box::new(BlockStmtOrExpr::Expr(Box::new(Expr::Member(
                              MemberExpr {
                                obj: Box::new(Expr::Call(CallExpr {
                                  callee: Callee::Expr(Box::new(Expr::Ident(cb.clone()))),
                                  ..Default::default()
                                })),
                                prop: MemberProp::Computed(ComputedPropName {
                                  span: DUMMY_SP,
                                  expr: Box::new(Expr::Ident(resources.clone())),
                                }),
                                span: DUMMY_SP,
                              },
                            )))),
                            ..Default::default()
                          })),
                        })))],
                        ..Default::default()
                      })),
                      spread: None,
                    },
                  ],
                  ..Default::default()
                })),
                span: DUMMY_SP,
              }),
              Stmt::Return(ReturnStmt {
                arg: Some(Box::new(Expr::Ident(lazy.clone()))),
                span: DUMMY_SP,
              }),
            ],
            ..Default::default()
          }),
          ..Default::default()
        }),
        ident: helper.clone(),
      }))))
    }
  }

  fn visit_mut_call_expr(&mut self, node: &mut CallExpr) {
    node.visit_mut_children_with(self);

    if let Callee::Expr(expr) = &mut node.callee {
      match &mut **expr {
        Expr::Ident(id) => {
          if let Some(import) = self.collect.imports.get(&id.to_id()) {
            if import.source == "react" && import.specifier == "lazy" {
              match &self.lazy {
                Some((lazy, _)) => {
                  *id = lazy.clone();
                }
                None => {
                  let callee = node.callee.clone();
                  let lazy = Ident::new_private("lazy".into(), DUMMY_SP);
                  node.callee = Callee::Expr(Box::new(Expr::Ident(lazy.clone())));
                  self.lazy = Some((lazy.clone(), callee));
                }
              }
            }
          }
        }
        Expr::Member(member) => {
          if let Expr::Ident(id) = &*member.obj {
            if let Some(import) = self.collect.imports.get(&id.to_id()) {
              if import.source == "react"
                && (import.specifier == "*" || import.specifier == "default")
              {
                match &self.lazy {
                  Some((lazy, _)) => {
                    **expr = Expr::Ident(lazy.clone());
                  }
                  None => {
                    let callee = node.callee.clone();
                    let lazy = Ident::new_private("lazy".into(), DUMMY_SP);
                    node.callee = Callee::Expr(Box::new(Expr::Ident(lazy.clone())));
                    self.lazy = Some((lazy.clone(), callee));
                  }
                }
              }
            }
          }
        }
        _ => {}
      }
    }
  }
}

#[cfg(test)]
mod test {
  use swc_core::common::Mark;
  use swc_core::ecma::transforms::base::hygiene::hygiene;
  use swc_core::ecma::visit::VisitWith;

  use super::*;
  use crate::test_utils::{run_with_transformation, RunTestContext};

  fn run(context: RunTestContext, module: &mut Module) {
    let mut collect = Collect::new(
      context.source_map.clone(),
      context.unresolved_mark,
      Mark::fresh(Mark::root()),
      context.global_mark,
      false,
      true,
    );
    module.visit_with(&mut collect);
    module.visit_mut_with(&mut ReactLazy::new(&collect));
    module.visit_mut_with(&mut hygiene());
  }

  #[test]
  fn test_named_import() {
    let code = r#"
import {lazy} from 'react';

const Foo = lazy(() => import('./lazy'));
    "#;
    let (output_code, _) = run_with_transformation(code, run);

    let expected_code = r#"import { lazy } from 'react';
const Foo = lazy1(()=>import('./lazy'));
function lazy1(cb) {
    var Lazy = lazy(cb), resources = Symbol.for("react.resources");
    Object.defineProperty(Lazy, resources, {
        get: ()=>cb()[resources]
    });
    return Lazy;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  fn test_renamed_import() {
    let code = r#"
import {lazy as myLazy} from 'react';

const Foo = myLazy(() => import('./lazy'));
    "#;
    let (output_code, _) = run_with_transformation(code, run);

    let expected_code = r#"import { lazy } from 'react';
const Foo = lazy(()=>import('./lazy'));
function lazy(cb) {
    var Lazy = myLazy(cb), resources = Symbol.for("react.resources");
    Object.defineProperty(Lazy, resources, {
        get: ()=>cb()[resources]
    });
    return Lazy;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  #[test]
  fn test_namespace_import() {
    let code = r#"
import * as React from 'react';

const Foo = React.lazy(() => import('./lazy'));
    "#;
    let (output_code, _) = run_with_transformation(code, run);

    let expected_code = r#"import * as React from 'react';
const Foo = lazy(()=>import('./lazy'));
function lazy(cb) {
    var Lazy = React.lazy(cb), resources = Symbol.for("react.resources");
    Object.defineProperty(Lazy, resources, {
        get: ()=>cb()[resources]
    });
    return Lazy;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  #[test]
  fn test_default_import() {
    let code = r#"
import React from 'react';

const Foo = React.lazy(() => import('./lazy'));
    "#;
    let (output_code, _) = run_with_transformation(code, run);

    let expected_code = r#"import React from 'react';
const Foo = lazy(()=>import('./lazy'));
function lazy(cb) {
    var Lazy = React.lazy(cb), resources = Symbol.for("react.resources");
    Object.defineProperty(Lazy, resources, {
        get: ()=>cb()[resources]
    });
    return Lazy;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  fn test_require() {
    let code = r#"
const React = require('react');

const Foo = React.lazy(() => import('./lazy'));
    "#;
    let (output_code, _) = run_with_transformation(code, run);

    let expected_code = r#"const React = require('react');
const Foo = lazy(()=>import('./lazy'));
function lazy(cb) {
    var Lazy = React.lazy(cb), resources = Symbol.for("react.resources");
    Object.defineProperty(Lazy, resources, {
        get: ()=>cb()[resources]
    });
    return Lazy;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  fn test_require_destructure() {
    let code = r#"
const {lazy} = require('react');

const Foo = lazy(() => import('./lazy'));
    "#;
    let (output_code, _) = run_with_transformation(code, run);

    let expected_code = r#"const {lazy} = require('react');
const Foo = lazy1(()=>import('./lazy'));
function lazy1(cb) {
    var Lazy = lazy(cb), resources = Symbol.for("react.resources");
    Object.defineProperty(Lazy, resources, {
        get: ()=>cb()[resources]
    });
    return Lazy;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }
}
