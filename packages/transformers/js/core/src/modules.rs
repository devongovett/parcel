use std::collections::{HashMap, HashSet};

use inflector::Inflector;
use swc_core::{
  common::{Mark, Span, SyntaxContext, DUMMY_SP},
  ecma::{
    ast::*,
    atoms::{js_word, JsWord},
    preset_env::{Feature, Versions},
    utils::stack_size::maybe_grow_default,
    visit::{Fold, FoldWith},
  },
};

use crate::{
  fold_member_expr_skip_prop, id,
  utils::{get_undefined_ident, match_export_name, match_export_name_ident},
};

pub fn esm2cjs(node: Module, unresolved_mark: Mark, versions: Option<Versions>) -> (Module, bool) {
  let mut fold = ESMFold {
    imports: HashMap::new(),
    require_names: HashMap::new(),
    interops: HashSet::new(),
    requires: vec![],
    exports: vec![],
    needs_helpers: false,
    in_export_decl: false,
    in_function_scope: false,
    mark: Mark::fresh(Mark::root()),
    unresolved_mark,
    versions,
  };

  let module = node.fold_with(&mut fold);
  (module, fold.needs_helpers)
}

struct ESMFold {
  // Map of imported identifier to (source, specifier)
  imports: HashMap<Id, (JsWord, JsWord)>,
  // Map of source to (require identifier, mark)
  require_names: HashMap<JsWord, (JsWord, Mark)>,
  // Set of declared default interops, by source.
  interops: HashSet<JsWord>,
  // List of requires to insert at the top of the module.
  requires: Vec<ModuleItem>,
  // List of exports to add.
  exports: Vec<ModuleItem>,
  needs_helpers: bool,
  in_export_decl: bool,
  in_function_scope: bool,
  mark: Mark,
  unresolved_mark: Mark,
  versions: Option<Versions>,
}

fn local_name_for_src(src: &JsWord) -> JsWord {
  if !src.contains('/') {
    return format!("_{}", src.to_camel_case()).into();
  }

  format!("_{}", src.split('/').last().unwrap().to_camel_case()).into()
}

impl ESMFold {
  fn get_require_name(&mut self, src: &JsWord, span: Span) -> Ident {
    if let Some((name, mark)) = self.require_names.get(src) {
      return Ident::new(name.clone(), span, SyntaxContext::empty().apply_mark(*mark));
    }

    let name = local_name_for_src(src);
    let mark = Mark::fresh(Mark::root());
    self.require_names.insert(src.clone(), (name.clone(), mark));
    Ident::new(name, span, SyntaxContext::empty().apply_mark(mark))
  }

  fn get_interop_default_name(&mut self, src: &JsWord) -> Ident {
    self.get_require_name(src, DUMMY_SP);
    let (name, mark) = self.require_names.get(src).unwrap();
    Ident::new(
      format!("{}Default", name).into(),
      DUMMY_SP,
      SyntaxContext::empty().apply_mark(*mark),
    )
  }

  fn create_require(&mut self, src: JsWord, span: Span) {
    if self.require_names.contains_key(&src) {
      return;
    }

    let ident = self.get_require_name(&src, DUMMY_SP);
    let require = ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
      span,
      ctxt: SyntaxContext::empty(),
      kind: VarDeclKind::Var,
      decls: vec![VarDeclarator {
        span: DUMMY_SP,
        name: Pat::Ident(ident.into()),
        init: Some(Box::new(Expr::Call(crate::utils::create_require(
          src,
          self.unresolved_mark,
        )))),
        definite: false,
      }],
      declare: false,
    }))));

    self.requires.push(require)
  }

  fn create_interop_default(&mut self, src: JsWord) {
    if self.interops.contains(&src) {
      return;
    }

    let local = self.get_require_name(&src, DUMMY_SP);
    let ident = self.get_interop_default_name(&src);
    let interop = ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
      span: DUMMY_SP,
      ctxt: SyntaxContext::empty(),
      kind: VarDeclKind::Var,
      decls: vec![VarDeclarator {
        span: DUMMY_SP,
        name: Pat::Ident(ident.into()),
        init: Some(Box::new(self.create_helper_call(
          "interopDefault".into(),
          vec![Expr::Ident(local)],
          DUMMY_SP,
        ))),
        definite: false,
      }],
      declare: false,
    }))));

    self.requires.push(interop);
    self.interops.insert(src);
  }

  fn create_helper_call(&mut self, name: JsWord, args: Vec<Expr>, span: Span) -> Expr {
    self.needs_helpers = true;
    let ident = Ident::new(
      "parcelHelpers".into(),
      DUMMY_SP,
      SyntaxContext::empty().apply_mark(self.mark),
    );
    Expr::Call(CallExpr {
      callee: Callee::Expr(Box::new(Expr::Member(MemberExpr {
        obj: Box::new(Expr::Ident(ident)),
        prop: MemberProp::Ident(IdentName::new(name, DUMMY_SP)),
        span: DUMMY_SP,
      }))),
      args: args
        .iter()
        .map(|arg| ExprOrSpread {
          expr: Box::new(arg.clone()),
          spread: None,
        })
        .collect(),
      span,
      ctxt: SyntaxContext::empty(),
      type_args: None,
    })
  }

  fn call_helper(&mut self, name: JsWord, args: Vec<Expr>, span: Span) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Expr(ExprStmt {
      expr: Box::new(self.create_helper_call(name, args, span)),
      span,
    }))
  }

  fn create_export(&mut self, exported: JsWord, local: Expr, span: Span) {
    let export = self.call_helper(
      js_word!("export"),
      vec![
        Expr::Ident(Ident::new_no_ctxt("exports".into(), DUMMY_SP)),
        Expr::Lit(Lit::Str(exported.into())),
        if matches!(self.versions, Some(versions) if Feature::ArrowFunctions.should_enable(versions, true, false)) {
          Expr::Fn(FnExpr {
            ident: None,
            function: Box::new(Function {
              body: Some(BlockStmt {
                span: DUMMY_SP,
                ctxt: SyntaxContext::empty(),
                stmts: vec![Stmt::Return({
                  ReturnStmt {
                    span: DUMMY_SP,
                    arg: Some(Box::new(local)),
                  }
                })],
              }),
              is_async: false,
              is_generator: false,
              params: vec![],
              decorators: vec![],
              span: DUMMY_SP,
              ctxt: SyntaxContext::empty(),
              return_type: None,
              type_params: None,
            }),
          })
        } else {
          Expr::Arrow(ArrowExpr {
            body: Box::new(BlockStmtOrExpr::Expr(Box::new(local))),
            is_async: false,
            is_generator: false,
            params: vec![],
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            return_type: None,
            type_params: None,
          })
        },
      ],
      span,
    );
    self.exports.push(export)
  }

  fn create_exports_assign(&mut self, name: JsWord, right: Expr, span: Span) -> ModuleItem {
    ModuleItem::Stmt(Stmt::Expr(ExprStmt {
      expr: Box::new(Expr::Assign(AssignExpr {
        op: AssignOp::Assign,
        left: AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
          obj: Box::new(Expr::Ident(Ident::new_no_ctxt("exports".into(), DUMMY_SP))),
          prop: MemberProp::Ident(IdentName::new(name, DUMMY_SP)),
          span: DUMMY_SP,
        })),
        right: Box::new(right),
        span: DUMMY_SP,
      })),
      span,
    }))
  }

  fn create_import_access(&mut self, source: &JsWord, imported: &JsWord, span: Span) -> Expr {
    if imported == "*" {
      let name = self.get_require_name(source, span);
      return Expr::Ident(name);
    }

    let obj = if imported == "default" {
      self.get_interop_default_name(source)
    } else {
      self.get_require_name(source, DUMMY_SP)
    };

    // import { foo } from "..."; foo();
    // ->
    // import { foo } from "..."; (0, foo)();
    Expr::Seq(SeqExpr {
      exprs: vec![
        0.into(),
        Box::new(Expr::Member(MemberExpr {
          obj: Box::new(Expr::Ident(obj)),
          prop: MemberProp::Ident(IdentName::new(imported.clone(), DUMMY_SP)),
          span,
        })),
      ],
      span,
    })
  }
}

macro_rules! modules_visit_fn {
  ($name:ident, $type:ident) => {
    fn $name(&mut self, node: $type) -> $type {
      let in_function_scope = self.in_function_scope;
      self.in_function_scope = true;
      let res = node.fold_children_with(self);
      self.in_function_scope = in_function_scope;
      res
    }
  };
}

impl Fold for ESMFold {
  fn fold_module(&mut self, node: Module) -> Module {
    let mut is_esm = false;
    let mut needs_interop_flag = false;

    // First pass: collect all imported declarations. On the second pass, exports can be matched to
    // imports (to better handle import/export pairs that are really just reexports).
    //
    // To ensure that all declarations that cause dependencies are kept in the same order, handle
    // export declarations with a source in the first pass as well.
    for item in &node.body {
      if let ModuleItem::ModuleDecl(decl) = &item {
        is_esm = true;
        match decl {
          ModuleDecl::Import(import) => {
            self.create_require(import.src.value.clone(), import.span);

            for specifier in &import.specifiers {
              match specifier {
                ImportSpecifier::Named(named) => {
                  let imported = match &named.imported {
                    Some(imported) => match_export_name(imported).0.clone(),
                    None => named.local.sym.clone(),
                  };
                  self.imports.insert(
                    id!(named.local),
                    (import.src.value.clone(), imported.clone()),
                  );
                  if imported == js_word!("default") {
                    self.create_interop_default(import.src.value.clone());
                  }
                }
                ImportSpecifier::Default(default) => {
                  self.imports.insert(
                    id!(default.local),
                    (import.src.value.clone(), "default".into()),
                  );
                  self.create_interop_default(import.src.value.clone());
                }
                ImportSpecifier::Namespace(namespace) => {
                  self
                    .imports
                    .insert(id!(namespace.local), (import.src.value.clone(), "*".into()));
                }
              }
            }
          }
          ModuleDecl::ExportNamed(export) => {
            needs_interop_flag = true;

            if let Some(src) = &export.src {
              self.create_require(src.value.clone(), export.span);

              for specifier in &export.specifiers {
                match specifier {
                  ExportSpecifier::Named(named) => {
                    let exported = match &named.exported {
                      Some(exported) => exported.clone(),
                      None => named.orig.clone(),
                    };

                    if match_export_name(&named.orig).0 == js_word!("default") {
                      self.create_interop_default(src.value.clone());
                    }

                    let specifier = self.create_import_access(
                      &src.value,
                      &match_export_name(&named.orig).0,
                      DUMMY_SP,
                    );
                    self.create_export(match_export_name(&exported).0, specifier, export.span);
                  }
                  ExportSpecifier::Default(default) => {
                    self.create_interop_default(src.value.clone());
                    let specifier =
                      self.create_import_access(&src.value, &js_word!("default"), DUMMY_SP);
                    self.create_export(default.exported.sym.clone(), specifier, export.span);
                  }
                  ExportSpecifier::Namespace(namespace) => {
                    let local = self.get_require_name(&src.value, DUMMY_SP);
                    self.create_export(
                      match_export_name(&namespace.name).0,
                      Expr::Ident(local),
                      export.span,
                    )
                  }
                }
              }
            } else {
              // Handled below
            }
          }
          ModuleDecl::ExportAll(export) => {
            needs_interop_flag = true;
            self.create_require(export.src.value.clone(), export.span);
            let require_name = self.get_require_name(&export.src.value, export.span);
            let export = self.call_helper(
              "exportAll".into(),
              vec![
                Expr::Ident(require_name),
                Expr::Ident(Ident::new_no_ctxt("exports".into(), DUMMY_SP)),
              ],
              export.span,
            );
            self.requires.push(export);
          }
          _ => (),
        }
      }
    }

    // If we didn't see any module declarations, nothing to do.
    if !is_esm {
      return node;
    }

    let node = node.fold_children_with(self);
    let mut items = vec![];

    // Second pass
    for item in &node.body {
      match &item {
        ModuleItem::ModuleDecl(decl) => {
          match decl {
            ModuleDecl::Import(_) | ModuleDecl::ExportAll(_) => {
              // Handled above
            }
            ModuleDecl::ExportNamed(export) => {
              needs_interop_flag = true;
              if export.src.is_none() {
                for specifier in &export.specifiers {
                  if let ExportSpecifier::Named(named) = specifier {
                    let exported = match &named.exported {
                      Some(exported) => exported.clone(),
                      None => named.orig.clone(),
                    };
                    let orig = match_export_name_ident(&named.orig);

                    // Handle import {foo} from 'bar'; export {foo};
                    let value =
                      if let Some((source, imported)) = self.imports.get(&id!(orig)).cloned() {
                        self.create_import_access(
                          &source,
                          &imported,
                          match_export_name(&named.orig).1,
                        )
                      } else {
                        Expr::Ident(orig.clone())
                      };

                    self.create_export(match_export_name(&exported).0, value, export.span);
                  }
                }
              } else {
                // Handled above
              }
            }
            ModuleDecl::ExportDefaultExpr(export) => {
              needs_interop_flag = true;
              items.push(self.create_exports_assign(
                "default".into(),
                *export.expr.clone(),
                export.span,
              ))
            }
            ModuleDecl::ExportDefaultDecl(export) => {
              needs_interop_flag = true;

              match &export.decl {
                DefaultDecl::Class(class) => {
                  if let Some(ident) = &class.ident {
                    items.push(ModuleItem::Stmt(Stmt::Decl(Decl::Class(ClassDecl {
                      ident: ident.clone(),
                      declare: false,
                      class: class.class.clone(),
                    }))));
                    items.push(self.create_exports_assign(
                      "default".into(),
                      Expr::Ident(ident.clone()),
                      DUMMY_SP,
                    ));
                  } else {
                    items.push(self.create_exports_assign(
                      "default".into(),
                      Expr::Class(ClassExpr {
                        ident: None,
                        class: class.class.clone(),
                      }),
                      export.span,
                    ));
                  }
                }
                DefaultDecl::Fn(func) => {
                  if let Some(ident) = &func.ident {
                    items.push(ModuleItem::Stmt(Stmt::Decl(Decl::Fn(FnDecl {
                      ident: ident.clone(),
                      declare: false,
                      function: func.function.clone(),
                    }))));
                    self.create_export("default".into(), Expr::Ident(ident.clone()), DUMMY_SP);
                  } else {
                    self.create_export(
                      "default".into(),
                      Expr::Fn(FnExpr {
                        ident: None,
                        function: func.function.clone(),
                      }),
                      export.span,
                    );
                  }
                }
                _ => {
                  unreachable!("unsupported export default declaration");
                }
              }
            }
            ModuleDecl::ExportDecl(export) => {
              needs_interop_flag = true;
              match &export.decl {
                Decl::Class(class) => {
                  self.create_export(
                    class.ident.sym.clone(),
                    Expr::Ident(class.ident.clone()),
                    export.span,
                  );
                  items.push(ModuleItem::Stmt(Stmt::Decl(
                    export.decl.clone().fold_with(self),
                  )));
                }
                Decl::Fn(func) => {
                  self.create_export(
                    func.ident.sym.clone(),
                    Expr::Ident(func.ident.clone()),
                    export.span,
                  );
                  items.push(ModuleItem::Stmt(Stmt::Decl(
                    export.decl.clone().fold_with(self),
                  )));
                }
                Decl::Var(var) => {
                  let mut var = var.clone();
                  var.decls = var
                    .decls
                    .iter()
                    .map(|decl| {
                      let mut decl = decl.clone();
                      self.in_export_decl = true;
                      decl.name = decl.name.clone().fold_with(self);
                      self.in_export_decl = false;
                      decl.init = decl.init.clone().fold_with(self);
                      decl
                    })
                    .collect();
                  items.push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(var))));
                }
                _ => {
                  items.push(ModuleItem::Stmt(Stmt::Decl(
                    export.decl.clone().fold_with(self),
                  )));
                }
              }
            }
            _ => items.push(item.clone()),
          }
        }
        _ => items.push(item.clone()),
      }
    }

    if needs_interop_flag {
      let helper = self.call_helper(
        "defineInteropFlag".into(),
        vec![Expr::Ident(Ident::new_no_ctxt("exports".into(), DUMMY_SP))],
        DUMMY_SP,
      );
      self.exports.insert(0, helper);
    }

    let mut node = node;
    items.splice(0..0, self.requires.clone());
    items.splice(0..0, self.exports.clone());

    if self.needs_helpers {
      items.insert(
        0,
        ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
          span: DUMMY_SP,
          ctxt: SyntaxContext::empty(),
          kind: VarDeclKind::Var,
          decls: vec![VarDeclarator {
            span: DUMMY_SP,
            name: Pat::Ident(
              Ident::new(
                "parcelHelpers".into(),
                DUMMY_SP,
                SyntaxContext::empty().apply_mark(self.mark),
              )
              .into(),
            ),
            init: Some(Box::new(Expr::Call(crate::utils::create_require(
              "@parcel/transformer-js/src/esmodule-helpers.js".into(),
              self.unresolved_mark,
            )))),
            definite: false,
          }],
          declare: false,
        })))),
      )
    }

    node.body = items;
    node
  }

  fn fold_binding_ident(&mut self, node: BindingIdent) -> BindingIdent {
    if self.in_export_decl {
      // export const {foo} = ...;
      self.create_export(node.id.sym.clone(), Expr::Ident(node.id.clone()), DUMMY_SP);
    }

    node.fold_children_with(self)
  }

  modules_visit_fn!(fold_function, Function);
  modules_visit_fn!(fold_class, Class);
  modules_visit_fn!(fold_getter_prop, GetterProp);
  modules_visit_fn!(fold_setter_prop, SetterProp);

  fn fold_expr(&mut self, node: Expr) -> Expr {
    match &node {
      Expr::Ident(ident) => {
        if let Some((source, imported)) = self.imports.get(&id!(ident)).cloned() {
          self.create_import_access(&source, &imported, ident.span)
        } else {
          node
        }
      }
      Expr::This(_this) => {
        if !self.in_function_scope {
          Expr::Ident(get_undefined_ident(self.unresolved_mark))
        } else {
          node
        }
      }
      _ => maybe_grow_default(|| node.fold_children_with(self)),
    }
  }

  fn fold_prop(&mut self, node: Prop) -> Prop {
    // let obj = {a, b}; -> let obj = {a: imported.a, b: imported.b};
    match &node {
      Prop::Shorthand(ident) => {
        if let Some((source, imported)) = self.imports.get(&id!(ident)).cloned() {
          Prop::KeyValue(KeyValueProp {
            key: PropName::Ident(IdentName::new(ident.sym.clone(), DUMMY_SP)),
            value: Box::new(self.create_import_access(&source, &imported, ident.span)),
          })
        } else {
          node.fold_children_with(self)
        }
      }
      _ => node.fold_children_with(self),
    }
  }

  fold_member_expr_skip_prop! {}
}
