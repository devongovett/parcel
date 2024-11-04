use std::{
  collections::{hash_map::DefaultHasher, HashMap, HashSet},
  hash::Hasher,
};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use swc_core::{
  common::{Mark, Span, SyntaxContext, DUMMY_SP},
  ecma::{
    ast::*,
    atoms::{js_word, JsWord},
    utils::stack_size::maybe_grow_default,
    visit::{Fold, FoldWith},
  },
};

use crate::{
  collect::{Collect, Export, Import, ImportKind},
  id,
  utils::{
    get_undefined_ident, is_unresolved, match_export_name, match_export_name_ident, match_import,
    match_member_expr, match_property_name, match_require, CodeHighlight, Diagnostic,
    DiagnosticSeverity, SourceLocation,
  },
};

macro_rules! hash {
  ($str:expr) => {{
    let mut hasher = DefaultHasher::new();
    hasher.write($str.as_bytes());
    hasher.finish()
  }};
}

pub fn hoist(
  module: Module,
  module_id: &str,
  unresolved_mark: Mark,
  collect: &Collect,
) -> Result<(Module, HoistResult, Vec<Diagnostic>), Vec<Diagnostic>> {
  let mut hoist = Hoist::new(module_id, unresolved_mark, collect);
  let module = module.fold_with(&mut hoist);

  if !hoist.diagnostics.is_empty() {
    return Err(hoist.diagnostics);
  }

  let diagnostics = std::mem::take(&mut hoist.diagnostics);
  Ok((module, hoist.get_result(), diagnostics))
}

/// An exported identifier with its original name and new mangled name.
///
/// When a file exports a symbol, parcel will rewrite it as a mangled
/// export identifier.
#[derive(Debug, Serialize, Deserialize)]
pub struct ExportedSymbol {
  /// The mangled name the transformer has generated and replaced the variable
  /// uses with
  pub local: JsWord,
  /// The original source name that was exported
  pub exported: JsWord,
  /// The location of this export
  pub loc: SourceLocation,
  pub is_esm: bool,
}

/// An imported identifier with its rename and original name
///
/// For example, if an ESM module import is seen:
///
/// ```skip
/// import { something } from './dependency-source';
/// ```
///
/// The transformer will replace this import statement with a mangled identififer.
///
/// * `source` will be `'./dependency-source'`
/// * `imported` will be `something`
/// * `local` will usually be a mangled name the transformer has generated and replaced the
///   call-site with - except for re-exports, in which case it's just the rename
/// * `loc` will be this source-code location
///
/// See [`HoistResult::imported_symbols`] and [`HoistResult::re_exports`].
#[derive(Debug, Serialize, Deserialize)]
pub struct ImportedSymbol {
  /// The specifier for a certain dependency this symbol comes from
  pub source: JsWord,
  /// The (usually mangled) local name for a certain imported symbol
  ///
  /// On re-exports, this is rather the rename for the import. See `HoistResult::re_exports`.
  pub local: JsWord,
  /// The original name for a certain imported symbol
  pub imported: JsWord,
  /// A location in the import site
  pub loc: SourceLocation,
  /// The type of import this symbol is coming from
  kind: ImportKind,
}

/// See [`HoistResult`] for field documentation.
struct Hoist<'a> {
  module_id: &'a str,
  collect: &'a Collect,
  module_items: Vec<ModuleItem>,
  export_decls: HashSet<JsWord>,
  hoisted_imports: IndexMap<JsWord, ModuleItem>,
  /// See [`HoistResult::imported_symbols`]
  imported_symbols: Vec<ImportedSymbol>,
  /// See [`HoistResult::exported_symbols`]
  exported_symbols: Vec<ExportedSymbol>,
  re_exports: Vec<ImportedSymbol>,
  /// See [`HoistResult::self_references`]
  self_references: HashSet<JsWord>,
  /// See [`HoistResult::dynamic_imports`]
  dynamic_imports: HashMap<JsWord, JsWord>,
  in_function_scope: bool,
  diagnostics: Vec<Diagnostic>,
  unresolved_mark: Mark,
}

/// Data pertaining to mangled identifiers replacing import and export statements
/// on transformed files.
#[derive(Debug, Default, Serialize, Deserialize)]
#[non_exhaustive]
pub struct HoistResult {
  /// A vector of the symbols imported from other files.
  ///
  /// For example, if a source file is:
  ///
  /// ```skip
  /// import { value as v1 } from './dependency-1';
  /// import { value as v2 } from './dependency-2';
  ///
  /// function main() {
  ///     console.log(v1);
  ///     console.log(v2);
  /// }
  /// ```
  ///
  /// The transformer will replace all usages of `v1` and `v2` with a mangled generated name.
  /// For example, the output will look like:
  ///
  /// ```skip
  /// import './dependency-1';
  /// import './dependency-2';
  ///
  /// function main() {
  ///     console.log((0, $abc$import$hashfashdfashdfahsdfh_v1));
  ///     console.log((0, $abc$import$hashfashdfashdfahsdfh_v2));
  /// }
  /// ```
  ///
  ///
  /// This `imported_symbols` vector will be:
  ///
  /// ```skip
  /// vec![
  ///     ImportedSymbol {
  ///         source: "dependency-1",
  ///         local: "$abc$import$hashfashdfashdfahsdfh_v1",
  ///         imported: "value",
  ///         ...
  ///     },
  ///     ImportedSymbol {
  ///         source: "dependency-2",
  ///         local: "$abc$import$hashfashdfashdfahsdfh_v2",
  ///         imported: "value",
  ///         ...
  ///     },
  /// ]
  /// ```
  ///
  /// `local` will be the manged name of the variables.
  pub imported_symbols: Vec<ImportedSymbol>,
  /// A vector of the symbols exported from this file, along with their mangled replacement
  /// identifiers.
  ///
  /// For example, if a source file is:
  ///
  /// ```skip
  /// export const x = 1234;
  /// export function something() {}
  /// ```
  ///
  /// The transformer will replace all usages of `x` and `something` with a mangled generated name.
  /// For example, the output will look like:
  ///
  /// ```skip
  /// const $abc$export$hashfashdfasdfahsdfh_x = 1234;
  /// function $abc$export$hashfashdfasdfahsdfh_something() {}
  /// ```
  ///
  ///
  /// This `exported_symbols` vector will be:
  ///
  /// ```skip
  /// vec![
  ///     ExportedSymbol {
  ///         exported: "x",
  ///         local: "$abc$export$hashfashdfashdfahsdfh_x",
  ///         ...
  ///     },
  ///     ExportedSymbol {
  ///         exported: "something",
  ///         local: "$abc$export$hashfashdfashdfahsdfh_something",
  ///         ...
  ///     },
  /// ]
  /// ```
  pub exported_symbols: Vec<ExportedSymbol>,
  /// Symbols re-exported from other modules.
  ///
  /// If a symbol is re-exported from another module, parcel will remove the export statement
  /// from the asset.
  ///
  /// For example, if an input file is:
  ///
  /// ```skip
  /// export { view as mainView } from './view';
  /// ```
  ///
  /// The output will be
  /// ```skip
  /// import 'abc:./view:esm';
  /// ```
  ///
  /// And this vector will contain the information about the re-exported symbol.
  ///
  /// On this case, the fields of `ImportedSymbol` will mean different things than they do for
  /// [`HoistResult::imported_symbols`].
  ///
  /// In particular, since there is no mangled name, `local` means the "exported" name rather than
  /// the mangled name.
  ///
  /// On the case above, this field would be:
  ///
  /// ```skip
  /// vec![
  ///     ImportedSymbol {
  ///         source: "./view",
  ///         local: "mainView",
  ///         imported: "view",
  ///         ...
  ///     },
  /// ]
  /// ```
  ///
  /// On the case the export statement is an export star:
  /// ```skip
  /// export * from './something';
  /// ```
  ///
  /// Then this array will have both `imported` and `local` set to a magic "*" value.
  pub re_exports: Vec<ImportedSymbol>,
  /// A vector of the 'original local' names of exported symbols that are self-referenced within the
  /// file they are being exported from.
  ///
  /// For example, if a file is:
  /// ```skip
  /// exports.foo = 10;
  /// exports.something = function() {
  ///     return exports.foo;
  /// }
  /// ```
  ///
  /// `self_references` will contain the `foo` symbol, un-mangled. Note the output will be mangled:
  /// ```skip
  /// var $abc$export$6a5cdcad01c973fa;
  /// var $abc$export$ce14ccb78c97a7d4;
  /// $abc$export$6a5cdcad01c973fa = 10;
  /// $abc$export$ce14ccb78c97a7d4 = function() {
  ///     return $abc$export$6a5cdcad01c973fa;
  /// };
  /// ```
  pub self_references: HashSet<JsWord>,
  /// When require statements are used programmatically, their sources will be collected here.
  ///
  /// These would be the module names of dynamically imported or required modules.
  ///
  /// TODO: add example
  pub wrapped_requires: HashSet<String>,
  /// A map of async import placeholder variable names to source specifiers.
  ///
  /// When a dynamic import expression is found in the input file (`import('dependency')`), it is
  /// replaced with a generated identifier.
  ///
  /// This output field contains a map of the generated placeholder variable to the dependency
  /// specifier (`'dependency'`).
  ///
  /// For example, if the source file is
  ///
  /// ```skip
  /// async function run() {
  ///     const viewModule = await import('./view');
  ///     viewModule.render();
  /// }
  /// ```
  ///
  /// And the `module_id` of this file is `"moduleId"`, then the transformer will replace this dynamic
  /// import (assume `12345` is a hash of the `'view'` value):
  ///
  /// ```skip
  /// async function run() {
  ///     const viewModule = await $moduleId$importAsync$12345;
  ///     viewModule.render();
  /// }
  /// ```
  ///
  /// The `dynamic_imports` field will then be:
  ///
  /// ```skip
  /// {
  ///     "$moduleId$importAsync$12345": "./view"
  /// }
  /// ```
  ///
  /// In other words, the keys are the generated identifier names, inserted by the transformer and
  /// the values, the specifiers on the original source code.
  pub dynamic_imports: HashMap<JsWord, JsWord>,
  pub static_cjs_exports: bool,
  pub has_cjs_exports: bool,
  pub is_esm: bool,
  pub should_wrap: bool,
}

impl<'a> Hoist<'a> {
  fn new(module_id: &'a str, unresolved_mark: Mark, collect: &'a Collect) -> Self {
    Hoist {
      module_id,
      collect,
      module_items: vec![],
      export_decls: HashSet::new(),
      hoisted_imports: IndexMap::new(),
      imported_symbols: vec![],
      exported_symbols: vec![],
      re_exports: vec![],
      self_references: HashSet::new(),
      dynamic_imports: HashMap::new(),
      in_function_scope: false,
      diagnostics: vec![],
      unresolved_mark,
    }
  }

  fn get_result(self) -> HoistResult {
    HoistResult {
      imported_symbols: self.imported_symbols,
      exported_symbols: self.exported_symbols,
      re_exports: self.re_exports,
      self_references: self.self_references,
      dynamic_imports: self.dynamic_imports,
      wrapped_requires: self.collect.wrapped_requires.clone(),
      static_cjs_exports: self.collect.static_cjs_exports,
      has_cjs_exports: self.collect.has_cjs_exports,
      is_esm: self.collect.is_esm,
      should_wrap: self.collect.should_wrap,
    }
  }
}

macro_rules! hoist_visit_fn {
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

impl<'a> Fold for Hoist<'a> {
  fn fold_module(&mut self, node: Module) -> Module {
    let mut node = node;
    for item in node.body {
      match item {
        ModuleItem::ModuleDecl(decl) => {
          match decl {
            ModuleDecl::Import(import) => {
              self.hoisted_imports.insert(
                import.src.value.clone(),
                ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
                  specifiers: vec![],
                  with: None,
                  span: DUMMY_SP,
                  src: Box::new(
                    format!("{}:{}:{}", self.module_id, import.src.value, "esm").into(),
                  ),
                  type_only: false,
                  phase: Default::default(),
                })),
              );
              // Ensure that all import specifiers are constant.
              for specifier in &import.specifiers {
                let local = match specifier {
                  ImportSpecifier::Named(named) => &named.local,
                  ImportSpecifier::Default(default) => &default.local,
                  ImportSpecifier::Namespace(ns) => &ns.local,
                };

                if let Some(spans) = self.collect.non_const_bindings.get(&id!(local)) {
                  let mut highlights: Vec<CodeHighlight> = spans
                    .iter()
                    .map(|span| CodeHighlight {
                      loc: SourceLocation::from(&self.collect.source_map, *span),
                      message: None,
                    })
                    .collect();

                  highlights.push(CodeHighlight {
                    loc: SourceLocation::from(&self.collect.source_map, local.span),
                    message: Some("Originally imported here".into()),
                  });

                  self.diagnostics.push(Diagnostic {
                    message: "Assignment to an import specifier is not allowed".into(),
                    code_highlights: Some(highlights),
                    hints: None,
                    show_environment: false,
                    severity: DiagnosticSeverity::Error,
                    documentation_url: None,
                  })
                }
              }
            }
            ModuleDecl::ExportNamed(export) => {
              if let Some(src) = export.src {
                self.hoisted_imports.insert(
                  src.value.clone(),
                  ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
                    specifiers: vec![],
                    with: None,
                    span: DUMMY_SP,
                    src: Box::new(Str {
                      value: format!("{}:{}:{}", self.module_id, src.value, "esm").into(),
                      span: DUMMY_SP,
                      raw: None,
                    }),
                    type_only: false,
                    phase: Default::default(),
                  })),
                );

                for specifier in export.specifiers {
                  match specifier {
                    ExportSpecifier::Named(named) => {
                      let exported = match named.exported {
                        Some(exported) => match_export_name(&exported).0,
                        None => match_export_name(&named.orig).0.clone(),
                      };
                      self.re_exports.push(ImportedSymbol {
                        source: src.value.clone(),
                        local: exported,
                        imported: match_export_name(&named.orig).0,
                        loc: SourceLocation::from(&self.collect.source_map, named.span),
                        kind: ImportKind::Import,
                      });
                    }
                    ExportSpecifier::Default(default) => {
                      self.re_exports.push(ImportedSymbol {
                        source: src.value.clone(),
                        local: default.exported.sym,
                        imported: js_word!("default"),
                        loc: SourceLocation::from(&self.collect.source_map, default.exported.span),
                        kind: ImportKind::Import,
                      });
                    }
                    ExportSpecifier::Namespace(namespace) => {
                      self.re_exports.push(ImportedSymbol {
                        source: src.value.clone(),
                        local: match_export_name(&namespace.name).0,
                        imported: "*".into(),
                        loc: SourceLocation::from(&self.collect.source_map, namespace.span),
                        kind: ImportKind::Import,
                      });
                    }
                  }
                }
              } else {
                for specifier in export.specifiers {
                  if let ExportSpecifier::Named(named) = specifier {
                    let id = id!(match_export_name_ident(&named.orig));
                    let exported = match named.exported {
                      Some(exported) => match_export_name(&exported).0,
                      None => match_export_name(&named.orig).0,
                    };
                    if let Some(Import {
                      source,
                      specifier,
                      kind,
                      ..
                    }) = self.collect.imports.get(&id)
                    {
                      self.re_exports.push(ImportedSymbol {
                        source: source.clone(),
                        local: exported,
                        imported: specifier.clone(),
                        loc: SourceLocation::from(&self.collect.source_map, named.span),
                        kind: *kind,
                      });
                    } else {
                      // A variable will appear only once in the `exports` mapping but
                      // could be exported multiple times with different names.
                      // Find the original exported name, and remap.
                      let id = if self.collect.should_wrap {
                        id.0
                      } else {
                        self
                          .get_export_ident(DUMMY_SP, self.collect.exports_locals.get(&id).unwrap())
                          .sym
                      };
                      self.exported_symbols.push(ExportedSymbol {
                        local: id,
                        exported,
                        loc: SourceLocation::from(&self.collect.source_map, named.span),
                        is_esm: true,
                      });
                    }
                  }
                }
              }
            }
            ModuleDecl::ExportAll(export) => {
              self.hoisted_imports.insert(
                export.src.value.clone(),
                ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
                  specifiers: vec![],
                  with: None,
                  span: DUMMY_SP,
                  src: Box::new(
                    format!("{}:{}:{}", self.module_id, export.src.value, "esm").into(),
                  ),
                  type_only: false,
                  phase: Default::default(),
                })),
              );
              self.re_exports.push(ImportedSymbol {
                source: export.src.value,
                local: "*".into(),
                imported: "*".into(),
                loc: SourceLocation::from(&self.collect.source_map, export.span),
                kind: ImportKind::Import,
              });
            }
            ModuleDecl::ExportDefaultExpr(export) => {
              let ident = self.get_export_ident(export.span, &"default".into());
              let init = export.expr.fold_with(self);
              self
                .module_items
                .push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
                  declare: false,
                  kind: VarDeclKind::Var,
                  span: DUMMY_SP,
                  ctxt: SyntaxContext::empty(),
                  decls: vec![VarDeclarator {
                    definite: false,
                    span: DUMMY_SP,
                    name: Pat::Ident(BindingIdent::from(ident)),
                    init: Some(init),
                  }],
                })))));
            }
            ModuleDecl::ExportDefaultDecl(export) => {
              let decl = match export.decl {
                DefaultDecl::Class(class) => Decl::Class(ClassDecl {
                  ident: if self.collect.should_wrap && class.ident.is_some() {
                    class.ident.unwrap()
                  } else {
                    self.get_export_ident(DUMMY_SP, &"default".into())
                  },
                  declare: false,
                  class: class.class.fold_with(self),
                }),
                DefaultDecl::Fn(func) => Decl::Fn(FnDecl {
                  ident: if self.collect.should_wrap && func.ident.is_some() {
                    func.ident.unwrap()
                  } else {
                    self.get_export_ident(DUMMY_SP, &"default".into())
                  },
                  declare: false,
                  function: func.function.fold_with(self),
                }),
                _ => {
                  unreachable!("unsupported export default declaration");
                }
              };

              self.module_items.push(ModuleItem::Stmt(Stmt::Decl(decl)));
            }
            ModuleDecl::ExportDecl(export) => {
              let d = export.decl.fold_with(self);
              self.module_items.push(ModuleItem::Stmt(Stmt::Decl(d)));
            }
            item => {
              let d = item.fold_with(self);
              self.module_items.push(ModuleItem::ModuleDecl(d))
            }
          }
        }
        ModuleItem::Stmt(stmt) => {
          match stmt {
            Stmt::Decl(decl) => {
              match decl {
                Decl::Var(var) => {
                  let mut decls = vec![];
                  for v in &var.decls {
                    if let Some(init) = &v.init {
                      // Match var x = require('foo');
                      if let Some(source) =
                        match_require(init, self.unresolved_mark, self.collect.ignore_mark)
                      {
                        // If the require is accessed in a way we cannot analyze, do not replace.
                        // e.g. const {x: {y: z}} = require('x');
                        // The require will be handled in the expression handler, below.
                        if !self.collect.non_static_requires.contains(&source) {
                          // If this is not the first declarator in the variable declaration, we need to
                          // split the declaration into multiple to preserve side effect ordering.
                          // var x = sideEffect(), y = require('foo'), z = 2;
                          //   -> var x = sideEffect(); import 'foo'; var y = $id$import$foo, z = 2;
                          if !decls.is_empty() {
                            let var = VarDecl {
                              span: var.span,
                              ctxt: var.ctxt,
                              kind: var.kind,
                              declare: var.declare,
                              decls: std::mem::take(&mut decls),
                            };
                            self
                              .module_items
                              .push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(var)))));
                          }

                          self
                            .module_items
                            .push(ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
                              specifiers: vec![],
                              with: None,
                              span: DUMMY_SP,
                              src: Box::new(Str {
                                value: format!("{}:{}", self.module_id, source).into(),
                                span: DUMMY_SP,
                                raw: None,
                              }),
                              type_only: false,
                              phase: Default::default(),
                            })));

                          // Create variable assignments for any declarations that are not constant.
                          self.handle_non_const_require(v, &source);
                          continue;
                        }
                      }

                      if let Expr::Member(member) = &**init {
                        // Match var x = require('foo').bar;
                        if let Some(source) =
                          match_require(&member.obj, self.unresolved_mark, self.collect.ignore_mark)
                        {
                          if !self.collect.non_static_requires.contains(&source) {
                            // If this is not the first declarator in the variable declaration, we need to
                            // split the declaration into multiple to preserve side effect ordering.
                            // var x = sideEffect(), y = require('foo').bar, z = 2;
                            //   -> var x = sideEffect(); import 'foo'; var y = $id$import$foo$bar, z = 2;
                            if !decls.is_empty() {
                              let var = VarDecl {
                                span: var.span,
                                ctxt: var.ctxt,
                                kind: var.kind,
                                declare: var.declare,
                                decls: std::mem::take(&mut decls),
                              };
                              self
                                .module_items
                                .push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(var)))));
                            }
                            self
                              .module_items
                              .push(ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
                                specifiers: vec![],
                                with: None,
                                span: DUMMY_SP,
                                src: Box::new(Str {
                                  value: format!("{}:{}", self.module_id, source,).into(),
                                  span: DUMMY_SP,
                                  raw: None,
                                }),
                                type_only: false,
                                phase: Default::default(),
                              })));

                            self.handle_non_const_require(v, &source);
                            continue;
                          }
                        }
                      }
                    }

                    // Otherwise, fold the variable initializer. If requires were found
                    // in the expression, they will be hoisted into module_items. If the
                    // length increases, then we need to split the variable declaration
                    // into multiple to preserve side effect ordering.
                    // var x = 2, y = doSomething(require('foo')), z = 3;
                    //   -> var x = 2; import 'foo'; var y = doSomething($id$import$foo), z = 3;
                    let items_len = self.module_items.len();
                    let d = v.clone().fold_with(self);
                    if self.module_items.len() > items_len && !decls.is_empty() {
                      let var = VarDecl {
                        span: var.span,
                        ctxt: var.ctxt,
                        kind: var.kind,
                        declare: var.declare,
                        decls: std::mem::take(&mut decls),
                      };
                      self.module_items.insert(
                        items_len,
                        ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(var)))),
                      );
                    }
                    decls.push(d);
                  }

                  // Push whatever declarators are left.
                  if !decls.is_empty() {
                    let var = VarDecl {
                      span: var.span,
                      ctxt: var.ctxt,
                      kind: var.kind,
                      declare: var.declare,
                      decls,
                    };
                    self
                      .module_items
                      .push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(var)))))
                  }
                }
                item => {
                  let d = item.fold_with(self);
                  self.module_items.push(ModuleItem::Stmt(Stmt::Decl(d)))
                }
              }
            }
            Stmt::Expr(ExprStmt { expr, span }) => {
              if let Some(source) =
                match_require(&expr, self.unresolved_mark, self.collect.ignore_mark)
              {
                // Require in statement position (`require('other');`) should behave just
                // like `import 'other';` in that it doesn't add any symbols (not even '*').
                self.add_require(&source, ImportKind::Require);
              } else {
                let d = expr.fold_with(self);
                self
                  .module_items
                  .push(ModuleItem::Stmt(Stmt::Expr(ExprStmt { expr: d, span })))
              }
            }
            item => {
              let d = item.fold_with(self);
              self.module_items.push(ModuleItem::Stmt(d))
            }
          }
        }
      }
    }

    self.module_items.splice(
      0..0,
      std::mem::take(&mut self.hoisted_imports).into_values(),
    );
    node.body = std::mem::take(&mut self.module_items);
    node
  }

  hoist_visit_fn!(fold_function, Function);
  hoist_visit_fn!(fold_class, Class);
  hoist_visit_fn!(fold_getter_prop, GetterProp);
  hoist_visit_fn!(fold_setter_prop, SetterProp);

  fn fold_expr(&mut self, node: Expr) -> Expr {
    match node {
      Expr::OptChain(opt) => {
        return Expr::OptChain(OptChainExpr {
          span: opt.span,
          optional: opt.optional,
          base: Box::new(match *opt.base {
            OptChainBase::Call(call) => OptChainBase::Call(call.fold_with(self)),
            OptChainBase::Member(member) => {
              if match_property_name(&member).is_some() {
                OptChainBase::Member(MemberExpr {
                  span: member.span,
                  obj: member.obj.fold_with(self),
                  // Don't visit member.prop so we avoid the ident visitor.
                  prop: member.prop,
                })
              } else {
                OptChainBase::Member(member.fold_children_with(self))
              }
            }
          }),
        });
      }
      Expr::Member(member) => {
        if !self.collect.should_wrap {
          if match_member_expr(&member, vec!["module", "exports"], self.unresolved_mark) {
            self.self_references.insert("*".into());
            return Expr::Ident(self.get_export_ident(member.span, &"*".into()));
          }

          if match_member_expr(&member, vec!["module", "hot"], self.unresolved_mark) {
            return Expr::Lit(Lit::Null(Null { span: member.span }));
          }
        }

        let key = match match_property_name(&member) {
          Some(v) => v.0,
          _ => return Expr::Member(member.fold_children_with(self)),
        };

        match &*member.obj {
          Expr::Ident(ident) => {
            // import * as y from 'x'; OR const y = require('x'); OR const y = await import('x');
            // y.foo -> $id$import$d141bba7fdc215a3$y
            if let Some(Import {
              source,
              specifier,
              kind,
              ..
            }) = self.collect.imports.get(&id!(ident))
            {
              // If there are any non-static accesses of the namespace, don't perform any replacement.
              // This will be handled in the Ident visitor below, which replaces y -> $id$import$d141bba7fdc215a3.
              if specifier == "*"
                && !self.collect.non_static_access.contains_key(&id!(ident))
                && !self.collect.non_const_bindings.contains_key(&id!(ident))
                && !self.collect.non_static_requires.contains(source)
              {
                if *kind == ImportKind::DynamicImport {
                  let name: JsWord = format!(
                    "${}$importAsync${:x}${:x}",
                    self.module_id,
                    hash!(source),
                    hash!(key)
                  )
                  .into();
                  self.imported_symbols.push(ImportedSymbol {
                    source: source.clone(),
                    local: name,
                    imported: key.clone(),
                    loc: SourceLocation::from(&self.collect.source_map, member.span),
                    kind: *kind,
                  });
                } else {
                  return Expr::Ident(self.get_import_ident(
                    member.span,
                    source,
                    &key,
                    SourceLocation::from(&self.collect.source_map, member.span),
                    *kind,
                  ));
                }
              }
            }

            // exports.foo -> $id$export$foo
            if &*ident.sym == "exports"
              && is_unresolved(&ident, self.unresolved_mark)
              && self.collect.static_cjs_exports
              && !self.collect.should_wrap
            {
              self.self_references.insert(key.clone());
              return Expr::Ident(self.get_export_ident(member.span, &key));
            }
          }
          Expr::Call(_) => {
            // require('foo').bar -> $id$import$foo$bar
            if let Some(source) =
              match_require(&member.obj, self.unresolved_mark, self.collect.ignore_mark)
            {
              self.add_require(&source, ImportKind::Require);
              return Expr::Ident(self.get_import_ident(
                member.span,
                &source,
                &key,
                SourceLocation::from(&self.collect.source_map, member.span),
                ImportKind::Require,
              ));
            }
          }
          Expr::Member(mem) => {
            // module.exports.foo -> $id$export$foo
            if self.collect.static_cjs_exports
              && !self.collect.should_wrap
              && match_member_expr(mem, vec!["module", "exports"], self.unresolved_mark)
            {
              self.self_references.insert(key.clone());
              return Expr::Ident(self.get_export_ident(member.span, &key));
            }
          }
          Expr::This(_) => {
            // this.foo -> $id$export$foo
            if self.collect.static_cjs_exports
              && !self.collect.should_wrap
              && !self.in_function_scope
              && !self.collect.is_esm
            {
              self.self_references.insert(key.clone());
              return Expr::Ident(self.get_export_ident(member.span, &key));
            }
          }
          _ => {}
        }

        // Don't visit member.prop so we avoid the ident visitor.
        return Expr::Member(MemberExpr {
          span: member.span,
          obj: member.obj.fold_with(self),
          prop: member.prop,
        });
      }
      Expr::Call(ref call) => {
        // require('foo') -> $id$import$foo
        if let Some(source) = match_require(&node, self.unresolved_mark, self.collect.ignore_mark) {
          self.add_require(&source, ImportKind::Require);
          return Expr::Ident(self.get_import_ident(
            call.span,
            &source,
            &("*".into()),
            SourceLocation::from(&self.collect.source_map, call.span),
            ImportKind::Require,
          ));
        }

        if let Some(source) = match_import(&node) {
          self.add_require(&source, ImportKind::DynamicImport);
          let name: JsWord = format!("${}$importAsync${:x}", self.module_id, hash!(source)).into();
          self.dynamic_imports.insert(name.clone(), source.clone());
          if self.collect.non_static_requires.contains(&source) || self.collect.should_wrap {
            self.imported_symbols.push(ImportedSymbol {
              source,
              local: name.clone(),
              imported: "*".into(),
              loc: SourceLocation::from(&self.collect.source_map, call.span),
              kind: ImportKind::DynamicImport,
            });
          }
          return Expr::Ident(Ident::new(name, call.span, call.ctxt));
        }
      }
      Expr::This(this) => {
        if !self.in_function_scope {
          // If ESM, replace `this` with `undefined`, otherwise with the CJS exports object.
          if self.collect.is_esm {
            return Expr::Ident(get_undefined_ident(self.unresolved_mark));
          } else if !self.collect.should_wrap {
            self.self_references.insert("*".into());
            return Expr::Ident(self.get_export_ident(this.span, &"*".into()));
          }
        }
      }
      Expr::Ident(ident) => {
        // import { foo } from "..."; foo();
        // ->
        // import { foo } from "..."; (0, foo)();
        if let Some(Import {
          specifier, kind, ..
        }) = self.collect.imports.get(&id!(ident))
        {
          if kind == &ImportKind::Import && specifier != "*" {
            return Expr::Seq(SeqExpr {
              span: ident.span,
              exprs: vec![0.into(), Box::new(Expr::Ident(ident.fold_with(self)))],
            });
          }
        }
        return Expr::Ident(ident.fold_with(self));
      }
      _ => {}
    }

    maybe_grow_default(|| node.fold_children_with(self))
  }

  fn fold_seq_expr(&mut self, node: SeqExpr) -> SeqExpr {
    // This is a hack to work around the SWC fixer pass removing identifiers in sequence expressions
    // that aren't at the end. In general this makes sense, but we need to preserve these so that they
    // can be replaced with a parcelRequire call in the linker. We just wrap with a unary expression to
    // get around this for now.
    let len = node.exprs.len();
    let exprs = node
      .exprs
      .into_iter()
      .enumerate()
      .map(|(i, expr)| {
        if i != len - 1
          && match_require(&expr, self.unresolved_mark, self.collect.ignore_mark).is_some()
        {
          return Box::new(Expr::Unary(UnaryExpr {
            op: UnaryOp::Bang,
            arg: expr.fold_with(self),
            span: DUMMY_SP,
          }));
        }

        expr.fold_with(self)
      })
      .collect();

    SeqExpr { exprs, ..node }
  }

  fn fold_ident(&mut self, node: Ident) -> Ident {
    // import {x} from 'y'; OR const {x} = require('y');
    // x -> $id$import$y$x
    //
    // import * as x from 'y'; OR const x = require('y');
    // x -> $id$import$y
    if let Some(Import {
      source,
      specifier,
      kind,
      loc,
      ..
    }) = self.collect.imports.get(&id!(node))
    {
      // If the require is accessed in a way we cannot analyze, do not replace.
      // e.g. const {x: {y: z}} = require('x');
      if !self.collect.non_static_requires.contains(source) {
        if *kind == ImportKind::DynamicImport {
          if specifier != "*" {
            let name: JsWord = format!(
              "${}$importAsync${:x}${:x}",
              self.module_id,
              hash!(source),
              hash!(specifier)
            )
            .into();
            self.imported_symbols.push(ImportedSymbol {
              source: source.clone(),
              local: name,
              imported: specifier.clone(),
              loc: loc.clone(),
              kind: *kind,
            });
          } else if self.collect.non_static_access.contains_key(&id!(node)) {
            let name: JsWord =
              format!("${}$importAsync${:x}", self.module_id, hash!(source)).into();
            self.imported_symbols.push(ImportedSymbol {
              source: source.clone(),
              local: name,
              imported: "*".into(),
              loc: loc.clone(),
              kind: *kind,
            });
          }
        } else {
          // If this identifier is not constant, we cannot directly reference the imported
          // value. Instead, a new local variable is created that originally points to the
          // required value, and we reference that instead. This allows the local variable
          // to be re-assigned without affecting the original exported variable.
          // See handle_non_const_require, below.
          if self.collect.non_const_bindings.contains_key(&id!(node)) {
            return self.get_require_ident(&node.sym);
          }

          return self.get_import_ident(node.span, source, specifier, loc.clone(), *kind);
        }
      }
    }

    if let Some(exported) = self.collect.exports_locals.get(&id!(node)) {
      // If wrapped, mark the original symbol as exported.
      // Otherwise replace with an export identifier.
      if self.collect.should_wrap {
        self.exported_symbols.push(ExportedSymbol {
          local: node.sym.clone(),
          exported: exported.clone(),
          loc: SourceLocation::from(&self.collect.source_map, node.span),
          is_esm: false,
        });
        return node;
      } else {
        return self.get_export_ident(node.span, exported);
      }
    }

    if &*node.sym == "exports"
      && is_unresolved(&node, self.unresolved_mark)
      && !self.collect.should_wrap
    {
      self.self_references.insert("*".into());
      return self.get_export_ident(node.span, &"*".into());
    }

    if node.sym == js_word!("global") && is_unresolved(&node, self.unresolved_mark) {
      return Ident::new("$parcel$global".into(), node.span, node.ctxt);
    }

    if node.ctxt.has_mark(self.collect.global_mark)
      && !is_unresolved(&node, self.unresolved_mark)
      && !self.collect.should_wrap
    {
      let new_name: JsWord = format!("${}$var${}", self.module_id, node.sym).into();
      return Ident::new(new_name, node.span, node.ctxt);
    }

    node
  }

  fn fold_assign_expr(&mut self, node: AssignExpr) -> AssignExpr {
    if self.collect.should_wrap {
      return node.fold_children_with(self);
    }

    if let AssignTarget::Simple(SimpleAssignTarget::Member(member)) = &node.left {
      if match_member_expr(member, vec!["module", "exports"], self.unresolved_mark) {
        let ident = BindingIdent::from(self.get_export_ident(member.span, &"*".into()));
        return AssignExpr {
          span: node.span,
          op: node.op,
          left: AssignTarget::Simple(SimpleAssignTarget::Ident(ident.into())),
          right: node.right.fold_with(self),
        };
      }

      let is_cjs_exports = match &*member.obj {
        Expr::Member(member) => {
          match_member_expr(member, vec!["module", "exports"], self.unresolved_mark)
        }
        Expr::Ident(ident) => {
          &*ident.sym == "exports" && is_unresolved(&ident, self.unresolved_mark)
        }
        Expr::This(_) if !self.in_function_scope => true,
        _ => false,
      };

      if is_cjs_exports {
        let key: JsWord = if self.collect.static_cjs_exports {
          if let Some((name, _)) = match_property_name(member) {
            name
          } else {
            unreachable!("Unexpected non-static CJS export");
          }
        } else {
          "*".into()
        };

        let ident = BindingIdent::from(self.get_export_ident(member.span, &key));
        if self.collect.static_cjs_exports && self.export_decls.insert(ident.id.sym.clone()) {
          self.hoisted_imports.insert(
            ident.id.sym.clone(),
            ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
              declare: false,
              kind: VarDeclKind::Var,
              span: node.span,
              ctxt: ident.ctxt,
              decls: vec![VarDeclarator {
                definite: false,
                span: node.span,
                name: Pat::Ident(BindingIdent::from(Ident::new(
                  ident.id.sym.clone(),
                  DUMMY_SP,
                  ident.ctxt,
                ))),
                init: None,
              }],
            })))),
          );
        }

        return AssignExpr {
          span: node.span,
          op: node.op,
          left: if self.collect.static_cjs_exports {
            AssignTarget::Simple(SimpleAssignTarget::Ident(ident.into()))
          } else {
            AssignTarget::Simple(SimpleAssignTarget::Member(MemberExpr {
              span: member.span,
              obj: Box::new(Expr::Ident(ident.id)),
              prop: member.prop.clone().fold_with(self),
            }))
          },
          right: node.right.fold_with(self),
        };
      }
    }

    node.fold_children_with(self)
  }

  fn fold_prop(&mut self, node: Prop) -> Prop {
    match node {
      Prop::Shorthand(ident) => Prop::KeyValue(KeyValueProp {
        key: PropName::Ident(IdentName::new(ident.sym.clone(), DUMMY_SP)),
        value: Box::new(Expr::Ident(ident.fold_with(self))),
      }),
      _ => node.fold_children_with(self),
    }
  }

  fn fold_prop_name(&mut self, node: PropName) -> PropName {
    match node {
      PropName::Computed(k) => PropName::Computed(k.fold_with(self)),
      k => k,
    }
  }

  fn fold_object_pat_prop(&mut self, node: ObjectPatProp) -> ObjectPatProp {
    if self.collect.should_wrap {
      return node.fold_children_with(self);
    }

    // var {a, b} = foo; -> var {a: $id$var$a, b: $id$var$b} = foo;
    match node {
      ObjectPatProp::Assign(assign) => ObjectPatProp::KeyValue(KeyValuePatProp {
        key: PropName::Ident(IdentName::new(assign.key.sym.clone(), DUMMY_SP)),
        value: Box::new(match assign.value {
          Some(value) => Pat::Assign(AssignPat {
            left: Box::new(Pat::Ident(BindingIdent::from(assign.key.fold_with(self)))),
            right: value.fold_with(self),
            span: DUMMY_SP,
          }),
          None => Pat::Ident(BindingIdent::from(assign.key.fold_with(self))),
        }),
      }),
      _ => node.fold_children_with(self),
    }
  }
}

impl<'a> Hoist<'a> {
  fn add_require(&mut self, source: &JsWord, import_kind: ImportKind) {
    let src = match import_kind {
      ImportKind::Import => format!("{}:{}:{}", self.module_id, source, "esm"),
      ImportKind::DynamicImport | ImportKind::Require => format!("{}:{}", self.module_id, source),
    };
    self
      .module_items
      .push(ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
        specifiers: vec![],
        with: None,
        span: DUMMY_SP,
        src: Box::new(src.into()),
        type_only: false,
        phase: Default::default(),
      })));
  }

  fn get_import_name(&self, source: &JsWord, local: &JsWord) -> JsWord {
    if local == "*" {
      format!("${}$import${:x}", self.module_id, hash!(source)).into()
    } else {
      format!(
        "${}$import${:x}${:x}",
        self.module_id,
        hash!(source),
        hash!(local)
      )
      .into()
    }
  }

  fn get_import_ident(
    &mut self,
    span: Span,
    source: &JsWord,
    imported: &JsWord,
    loc: SourceLocation,
    kind: ImportKind,
  ) -> Ident {
    let new_name = self.get_import_name(source, imported);
    self.imported_symbols.push(ImportedSymbol {
      source: source.clone(),
      local: new_name.clone(),
      imported: imported.clone(),
      loc,
      kind,
    });
    Ident::new_no_ctxt(new_name, span)
  }

  fn get_require_ident(&self, local: &JsWord) -> Ident {
    Ident::new_no_ctxt(
      format!("${}$require${}", self.module_id, local).into(),
      DUMMY_SP,
    )
  }

  fn get_export_ident(&mut self, span: Span, exported: &JsWord) -> Ident {
    let new_name: JsWord = if exported == "*" {
      format!("${}$exports", self.module_id).into()
    } else {
      format!("${}$export${:x}", self.module_id, hash!(exported)).into()
    };

    let is_esm = matches!(
      self.collect.exports.get(exported),
      Some(Export { is_esm: true, .. })
    );

    self.exported_symbols.push(ExportedSymbol {
      local: new_name.clone(),
      exported: exported.clone(),
      loc: SourceLocation::from(&self.collect.source_map, span),
      is_esm,
    });

    Ident::new_no_ctxt(new_name, span)
  }

  fn handle_non_const_require(&mut self, v: &VarDeclarator, source: &JsWord) {
    // If any of the bindings in this declarator are not constant, we need to create
    // a local variable referencing them so that we can safely re-assign the local variable
    // without affecting the original export. This is only possible in CommonJS since ESM
    // imports are constant (this is ensured by the diagnostic in fold_module above).
    let mut non_const_bindings = vec![];
    self
      .collect
      .get_non_const_binding_idents(&v.name, &mut non_const_bindings);

    for ident in non_const_bindings {
      if let Some(Import {
        specifier, kind, ..
      }) = self.collect.imports.get(&id!(ident))
      {
        let require_id = self.get_require_ident(&ident.sym);
        let import_id = self.get_import_ident(
          v.span,
          source,
          specifier,
          SourceLocation::from(&self.collect.source_map, v.span),
          *kind,
        );
        self
          .module_items
          .push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(Box::new(VarDecl {
            declare: false,
            kind: VarDeclKind::Var,
            span: DUMMY_SP,
            ctxt: SyntaxContext::empty(),
            decls: vec![VarDeclarator {
              definite: false,
              span: DUMMY_SP,
              name: Pat::Ident(BindingIdent::from(require_id)),
              init: Some(Box::new(Expr::Ident(import_id))),
            }],
          })))));
      }
    }
  }
}

#[cfg(test)]
mod tests {
  use swc_core::{
    common::{chain, comments::SingleThreadedComments, sync::Lrc, FileName, Globals, SourceMap},
    ecma::{
      codegen::text_writer::JsWriter,
      parser::{lexer::Lexer, Parser, StringInput},
      transforms::base::{fixer::fixer, hygiene::hygiene, resolver},
      visit::VisitWith,
    },
  };

  use super::*;
  use crate::utils::BailoutReason;
  extern crate indoc;
  use self::indoc::indoc;

  fn parse(code: &str) -> (Collect, String, HoistResult) {
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
    match parser.parse_program() {
      Ok(program) => swc_core::common::GLOBALS.set(&Globals::new(), || {
        swc_core::ecma::transforms::base::helpers::HELPERS.set(
          &swc_core::ecma::transforms::base::helpers::Helpers::new(false),
          || {
            let is_module = program.is_module();
            let module = match program {
              Program::Module(module) => module,
              Program::Script(script) => Module {
                span: script.span,
                shebang: None,
                body: script.body.into_iter().map(ModuleItem::Stmt).collect(),
              },
            };

            let unresolved_mark = Mark::fresh(Mark::root());
            let global_mark = Mark::fresh(Mark::root());
            let module = module.fold_with(&mut resolver(unresolved_mark, global_mark, false));

            let mut collect = Collect::new(
              source_map.clone(),
              unresolved_mark,
              Mark::fresh(Mark::root()),
              global_mark,
              true,
              is_module,
            );
            module.visit_with(&mut collect);

            let (module, res) = {
              let mut hoist = Hoist::new("abc", unresolved_mark, &collect);
              let module = module.fold_with(&mut hoist);
              (module, hoist.get_result())
            };

            let module = module.fold_with(&mut chain!(hygiene(), fixer(Some(&comments))));

            let code = emit(source_map, comments, &module);
            (collect, code, res)
          },
        )
      }),
      Err(err) => {
        panic!("{:?}", err);
      }
    }
  }

  fn emit(source_map: Lrc<SourceMap>, comments: SingleThreadedComments, module: &Module) -> String {
    let mut src_map_buf = vec![];
    let mut buf = vec![];
    {
      let writer = Box::new(JsWriter::new(
        source_map.clone(),
        "\n",
        &mut buf,
        Some(&mut src_map_buf),
      ));
      let config =
        swc_core::ecma::codegen::Config::default().with_target(swc_core::ecma::ast::EsVersion::Es5);
      let mut emitter = swc_core::ecma::codegen::Emitter {
        cfg: config,
        comments: Some(&comments),
        cm: source_map,
        wr: writer,
      };

      emitter.emit_module(module).unwrap();
    }

    String::from_utf8(buf).unwrap()
  }

  macro_rules! map(
    { $($key:expr => $value:expr),* } => {
      {
        #[allow(unused_mut)]
        let mut m = HashMap::new();
        $(
          m.insert($key, $value);
        )*
        m
      }
    };
  );

  macro_rules! set(
    { $($key:expr),* } => {
      {
        #[allow(unused_mut)]
        let mut m = HashSet::new();
        $(
          m.insert($key);
        )*
        m
      }
    };
  );

  macro_rules! w {
    ($s: expr) => {{
      let w: JsWord = $s.into();
      w
    }};
  }

  macro_rules! assert_eq_imports {
    ($m: expr, $match: expr) => {{
      let mut map = HashMap::new();
      for (key, val) in $m {
        map.insert(
          key.0,
          (
            val.source,
            val.specifier,
            val.kind == ImportKind::DynamicImport,
          ),
        );
      }
      assert_eq!(map, $match);
    }};
  }

  macro_rules! assert_eq_imported_symbols {
    ($m: expr, $match: expr) => {{
      let mut map = HashMap::new();
      for sym in $m {
        map.insert(sym.local, (sym.source, sym.imported));
      }
      assert_eq!(map, $match);
    }};
  }

  macro_rules! assert_eq_exported_symbols {
    ($m: expr, $match: expr) => {{
      let mut map = HashMap::new();
      for sym in $m {
        map.insert(sym.exported, (sym.local, sym.is_esm));
      }
      assert_eq!(map, $match);
    }};
  }

  macro_rules! assert_eq_set {
    ($m: expr, $match: expr) => {{
      let mut map = HashSet::new();
      for item in $m {
        map.insert(item.0);
      }
      assert_eq!(map, $match);
    }};
  }

  #[test]
  fn collect_esm() {
    let (collect, _code, _hoist) = parse(
      r#"
    import {foo as bar} from 'other';
    export {bar as test};
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("bar") => (w!("other"), w!("foo"), false) }
    );
    assert_eq!(
      collect.exports,
      map! {
        w!("test") => Export {
          source: Some("other".into()),
          specifier: "foo".into(),
          loc: SourceLocation {
            start_line: 3,
            start_col: 20,
            end_line: 3,
            end_col: 24
          },
          is_esm: true
        }
      }
    );

    let (collect, _code, _hoist) = parse(
      r#"
    import { a, b, c, d, e } from "other";
    import * as x from "other";
    import * as y from "other";

    log(a);
    b.x();
    c();
    log(x);
    y.foo();
    e.foo.bar();
    "#,
    );
    assert_eq_set!(
      collect.used_imports,
      set! { w!("a"), w!("b"), w!("c"), w!("e"), w!("x"), w!("y") }
    );
    assert_eq_imports!(
      collect.imports,
      map! {
        w!("a") => (w!("other"), w!("a"), false),
        w!("b") => (w!("other"), w!("b"), false),
        w!("c") => (w!("other"), w!("c"), false),
        w!("d") => (w!("other"), w!("d"), false),
        w!("e") => (w!("other"), w!("e"), false),
        w!("x") => (w!("other"), w!("*"), false),
        w!("y") => (w!("other"), w!("*"), false)
      }
    );
  }

  #[test]
  fn collect_cjs_namespace() {
    let (collect, _code, _hoist) = parse(
      r#"
    const x = require('other');
    console.log(x.foo);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), false) }
    );
    assert_eq!(collect.non_static_access, map! {});

    let (_collect, _code, hoist) = parse(
      r#"
      require('other');
    "#,
    );
    assert_eq_imported_symbols!(hoist.imported_symbols, map! {});
  }

  #[test]
  fn collect_cjs_namespace_non_static() {
    let (collect, _code, _hoist) = parse(
      r#"
    const x = require('other');
    console.log(x[foo]);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), false) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! { w!("x") });

    let (collect, _code, _hoist) = parse(
      r#"
    const x = require('other');
    console.log(x);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), false) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! { w!("x") });
  }

  #[test]
  fn collect_cjs_destructure() {
    let (collect, _code, _hoist) = parse(
      r#"
    const {foo: bar} = require('other');
    exports.test = bar;
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("bar") => (w!("other"), w!("foo"), false) }
    );
    assert!(collect.static_cjs_exports);
  }

  #[test]
  fn collect_destructure_default() {
    let (collect, _code, _hoist) = parse(
      r#"
    import {bar} from 'source';

    export function thing(props) {
      const {something = bar} = props;
      return something;
    }
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("bar") => (w!("source"), w!("bar"), false) }
    );
    assert_eq_set!(collect.used_imports, set! { w!("bar") });
  }

  #[test]
  fn collect_cjs_reassign() {
    let (collect, _code, _hoist) = parse(
      r#"
    exports = 2;
    "#,
    );
    assert!(collect.should_wrap);

    let (collect, _code, _hoist) = parse(
      r#"
    module = 2;
    "#,
    );
    assert!(collect.should_wrap);
  }

  #[test]
  fn collect_has_cjs_exports() {
    let (collect, _code, _hoist) = parse(
      r#"
      module.exports = {};
    "#,
    );
    assert!(collect.has_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
      this.someExport = 'true';
    "#,
    );
    assert!(collect.has_cjs_exports);

    // Some TSC polyfills use a pattern like below.
    // We want to avoid marking these modules as CJS
    let (collect, _code, _hoist) = parse(
      r#"
      import 'something';
      var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function () {}
    "#,
    );
    assert!(!collect.has_cjs_exports);
  }

  #[test]
  fn collect_should_wrap() {
    let (collect, _code, _hoist) = parse(
      r#"
    eval('');
    "#,
    );
    assert!(collect.should_wrap);

    let (collect, _code, _hoist) = parse(
      r#"
    doSomething(module);
    "#,
    );
    assert!(collect.should_wrap);

    let (collect, _code, _hoist) = parse(
      r#"
    console.log(module.id);
    "#,
    );
    assert!(collect.should_wrap);

    let (collect, _code, _hoist) = parse(
      r#"
    console.log(typeof module);
    console.log(module.hot);
    "#,
    );
    assert!(!collect.should_wrap);

    let (collect, _code, _hoist) = parse(
      r#"
    exports.foo = 2;
    return;
    exports.bar = 3;
    "#,
    );
    assert!(collect.should_wrap);

    let (collect, _code, _hoist) = parse(
      r#"
    const foo = {
      get a() {
        return 1;
      },
      set b(v) {
        return;
      },
      run() {
        return 3;
      },
    };
    console.log(foo.a);
    "#,
    );
    assert!(!collect.should_wrap);
  }

  #[test]
  fn collect_cjs_non_static_exports() {
    let (collect, _code, _hoist) = parse(
      r#"
    exports[test] = 2;
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    module.exports[test] = 2;
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    this[test] = 2;
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    module.exports[test] = 2;
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    alert(exports)
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    alert(module.exports)
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    alert(this)
    "#,
    );
    assert!(!collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    exports.foo = 2;
    "#,
    );
    assert!(collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    module.exports.foo = 2;
    "#,
    );
    assert!(collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    this.foo = 2;
    "#,
    );
    assert!(collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    var exports = {};
    exports[foo] = 2;
    "#,
    );
    assert!(collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    var module = {exports: {}};
    module.exports[foo] = 2;
    "#,
    );
    assert!(collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    test(function(exports) { return Object.keys(exports) })
    "#,
    );
    assert!(collect.static_cjs_exports);

    let (collect, _code, _hoist) = parse(
      r#"
    test(exports => Object.keys(exports))
    "#,
    );
    assert!(collect.static_cjs_exports);
  }

  #[test]
  fn collect_dynamic_import() {
    let (collect, _code, _hoist) = parse(
      r#"
    async function test() {
      const x = await import('other');
      x.foo;
    }
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), true) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! {});
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    async function test() {
      const x = await import('other');
      x[foo];
    }
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), true) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! { w!("x") });
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    async function test() {
      const {foo} = await import('other');
    }
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("foo") => (w!("other"), w!("foo"), true) }
    );
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    async function test() {
      const {foo: bar} = await import('other');
    }
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("bar") => (w!("other"), w!("foo"), true) }
    );
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(x => x.foo);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), true) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! {});
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(x => x);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), true) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! { w!("x") });
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(({foo}) => foo);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("foo") => (w!("other"), w!("foo"), true) }
    );
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(({foo: bar}) => bar);
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("bar") => (w!("other"), w!("foo"), true) }
    );
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(function (x) { return x.foo });
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), true) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! {});
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(function (x) { return x });
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("x") => (w!("other"), w!("*"), true) }
    );
    assert_eq_set!(collect.non_static_access.into_keys(), set! { w!("x") });
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(function ({foo}) {});
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("foo") => (w!("other"), w!("foo"), true) }
    );
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other').then(function ({foo: bar}) {});
    "#,
    );
    assert_eq_imports!(
      collect.imports,
      map! { w!("bar") => (w!("other"), w!("foo"), true) }
    );
    assert_eq!(collect.non_static_requires, set! {});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    import('other');
    "#,
    );
    assert_eq_imports!(collect.imports, map! {});
    assert_eq!(collect.non_static_requires, set! {w!("other")});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    let other = import('other');
    "#,
    );
    assert_eq_imports!(collect.imports, map! {});
    assert_eq!(collect.non_static_requires, set! {w!("other")});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});

    let (collect, _code, _hoist) = parse(
      r#"
    async function test() {
      let {...other} = await import('other');
    }
    "#,
    );
    assert_eq_imports!(collect.imports, map! {});
    assert_eq!(collect.non_static_requires, set! {w!("other")});
    assert_eq!(collect.wrapped_requires, set! {String::from("other")});
  }

  #[test]
  fn fold_import() {
    let (collect, code, _hoist) = parse(
      r#"
    import {foo as bar} from 'other';
    let test = {bar: 3};
    console.log(bar, test.bar);
    bar();
    "#,
    );

    assert!(collect.bailouts.unwrap().is_empty());

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    let $abc$var$test = {
        bar: 3
    };
    console.log((0, $abc$import$70a00e0a8474f72a$6a5cdcad01c973fa), $abc$var$test.bar);
    (0, $abc$import$70a00e0a8474f72a$6a5cdcad01c973fa)();
    "#}
    );

    let (collect, code, _hoist) = parse(
      r#"
    import * as foo from 'other';
    console.log(foo.bar);
    foo.bar();
    "#,
    );
    assert!(collect.bailouts.unwrap().is_empty());

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    console.log($abc$import$70a00e0a8474f72a$d927737047eb3867);
    $abc$import$70a00e0a8474f72a$d927737047eb3867();
    "#}
    );

    let (collect, code, _hoist) = parse(
      r#"
    import * as foo from 'other';
    foo.bar();
    let y = "bar";
    foo[y]();
    "#,
    );
    assert_eq!(
      collect
        .bailouts
        .unwrap()
        .iter()
        .map(|b| &b.reason)
        .collect::<Vec<_>>(),
      vec![&BailoutReason::NonStaticAccess]
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    $abc$import$70a00e0a8474f72a.bar();
    let $abc$var$y = "bar";
    $abc$import$70a00e0a8474f72a[$abc$var$y]();
    "#}
    );

    let (collect, code, _hoist) = parse(
      r#"
    import other from 'other';
    console.log(other, other.bar);
    other();
    "#,
    );

    assert!(collect.bailouts.unwrap().is_empty());

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    console.log((0, $abc$import$70a00e0a8474f72a$2e2bcd8739ae039), (0, $abc$import$70a00e0a8474f72a$2e2bcd8739ae039).bar);
    (0, $abc$import$70a00e0a8474f72a$2e2bcd8739ae039)();
    "#}
    );
  }

  #[test]
  fn fold_import_hoist() {
    let (_collect, code, _hoist) = parse(
      r#"
    import foo from 'other';
    console.log(foo);
    import bar from 'bar';
    console.log(bar);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    import "abc:bar:esm";
    console.log((0, $abc$import$70a00e0a8474f72a$2e2bcd8739ae039));
    console.log((0, $abc$import$d927737047eb3867$2e2bcd8739ae039));
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    import foo from 'other';
    console.log(foo);
    const x = require('x');
    console.log(x);
    import bar from 'bar';
    console.log(bar);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    import "abc:bar:esm";
    console.log((0, $abc$import$70a00e0a8474f72a$2e2bcd8739ae039));
    import "abc:x";
    console.log($abc$import$d141bba7fdc215a3);
    console.log((0, $abc$import$d927737047eb3867$2e2bcd8739ae039));
    "#}
    );
  }

  #[test]
  fn fold_static_require() {
    let (_collect, code, _hoist) = parse(
      r#"
    const x = 4, {bar} = require('other'), baz = 3;
    console.log(bar);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    const $abc$var$x = 4;
    import "abc:other";
    var $abc$require$bar = $abc$import$70a00e0a8474f72a$d927737047eb3867;
    const $abc$var$baz = 3;
    console.log($abc$require$bar);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    const x = 3, foo = require('other'), bar = 2;
    console.log(foo.bar);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    const $abc$var$x = 3;
    import "abc:other";
    const $abc$var$bar = 2;
    console.log($abc$import$70a00e0a8474f72a$d927737047eb3867);
    "#}
    );
  }

  #[test]
  fn fold_non_static_require() {
    let (_collect, code, _hoist) = parse(
      r#"
    const {foo, ...bar} = require('other');
    console.log(foo, bar);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    const { foo: $abc$var$foo, ...$abc$var$bar } = $abc$import$70a00e0a8474f72a;
    console.log($abc$var$foo, $abc$var$bar);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    const {x: {y: z}} = require('x');
    console.log(z);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:x";
    const { x: { y: $abc$var$z } } = $abc$import$d141bba7fdc215a3;
    console.log($abc$var$z);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    const foo = require('other');
    console.log(foo[bar]);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    console.log($abc$import$70a00e0a8474f72a[bar]);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    const foo = require('other');
    console.log(foo[bar], foo.baz);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    console.log($abc$import$70a00e0a8474f72a[bar], $abc$import$70a00e0a8474f72a.baz);
    "#}
    );
  }

  #[test]
  fn fold_require_member() {
    // let (_collect, code, _hoist) = parse(r#"
    // let foo;
    // ({foo} = require('other'));
    // console.log(foo);
    // "#);

    // println!("{}", code);

    let (_collect, code, _hoist) = parse(
      r#"
    const foo = require('other').foo;
    console.log(foo);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    var $abc$require$foo = $abc$import$70a00e0a8474f72a$6a5cdcad01c973fa;
    console.log($abc$require$foo);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    const foo = require('other')[bar];
    console.log(foo);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    const $abc$var$foo = $abc$import$70a00e0a8474f72a[bar];
    console.log($abc$var$foo);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    const {foo} = require('other').foo;
    console.log(foo);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    const { foo: $abc$var$foo } = $abc$import$70a00e0a8474f72a$6a5cdcad01c973fa;
    console.log($abc$var$foo);
    "#}
    );
  }

  #[test]
  fn fold_require_wrapped() {
    let (_collect, code, hoist) = parse(
      r#"
    function x() {
      const foo = require('other');
      console.log(foo.bar);
    }
    require('bar');
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    function $abc$var$x() {
        const foo = $abc$import$70a00e0a8474f72a;
        console.log(foo.bar);
    }
    import "abc:bar";
    "#}
    );
    assert_eq!(
      hoist.wrapped_requires,
      HashSet::<String>::from_iter(vec![String::from("other")])
    );

    let (_collect, code, hoist) = parse(
      r#"
    var foo = function () {
      if (Date.now() < 0) {
        var bar = require("other");
      }
    }();
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    var $abc$var$foo = function() {
        if (Date.now() < 0) {
            var bar = $abc$import$70a00e0a8474f72a;
        }
    }();
    "#}
    );
    assert_eq!(
      hoist.wrapped_requires,
      HashSet::<String>::from_iter(vec![String::from("other")])
    );

    let (_collect, code, _hoist) = parse(
      r#"
    function x() {
      const foo = require('other').foo;
      console.log(foo);
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    function $abc$var$x() {
        const foo = $abc$import$70a00e0a8474f72a$6a5cdcad01c973fa;
        console.log(foo);
    }
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    function x() {
      console.log(require('other').foo);
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    function $abc$var$x() {
        console.log($abc$import$70a00e0a8474f72a$6a5cdcad01c973fa);
    }
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    function x() {
      const foo = require('other')[test];
      console.log(foo);
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    function $abc$var$x() {
        const foo = $abc$import$70a00e0a8474f72a[test];
        console.log(foo);
    }
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    function x() {
      const {foo} = require('other');
      console.log(foo);
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    function $abc$var$x() {
        const { foo: foo } = $abc$import$70a00e0a8474f72a;
        console.log(foo);
    }
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    let x = require('a') + require('b');
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:a";
    import "abc:b";
    let $abc$var$x = $abc$import$407448d2b89b1813 + $abc$import$8b22cf2602fb60ce;
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    let x = (require('a'), require('b'));
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:a";
    import "abc:b";
    let $abc$var$x = (!$abc$import$407448d2b89b1813, $abc$import$8b22cf2602fb60ce);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    let x = require('a') || require('b');
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:a";
    import "abc:b";
    let $abc$var$x = $abc$import$407448d2b89b1813 || $abc$import$8b22cf2602fb60ce;
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    let x = condition ? require('a') : require('b');
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:a";
    import "abc:b";
    let $abc$var$x = condition ? $abc$import$407448d2b89b1813 : $abc$import$8b22cf2602fb60ce;
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    if (condition) require('a');
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:a";
    if (condition) $abc$import$407448d2b89b1813;
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    for (let x = require('y'); x < 5; x++) {}
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:y";
    for(let x = $abc$import$4a5767248b18ef41; x < 5; x++){}
    "#}
    );
  }

  #[test]
  fn fold_export() {
    let (_collect, code, hoist) = parse(
      r#"
    let x = 3;
    let y = 4;
    let z = 6;
    export {x, y};
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    let $abc$export$d141bba7fdc215a3 = 3;
    let $abc$export$4a5767248b18ef41 = 4;
    let $abc$var$z = 6;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("x") => (w!("$abc$export$d141bba7fdc215a3"), true),
        w!("y") => (w!("$abc$export$4a5767248b18ef41"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export default 3;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$2e2bcd8739ae039 = 3;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("default") => (w!("$abc$export$2e2bcd8739ae039"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    let x = 3;
    export default x;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    let $abc$var$x = 3;
    var $abc$export$2e2bcd8739ae039 = $abc$var$x;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("default") => (w!("$abc$export$2e2bcd8739ae039"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export default function () {}
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    function $abc$export$2e2bcd8739ae039() {}
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("default") => (w!("$abc$export$2e2bcd8739ae039"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export default class {}
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    class $abc$export$2e2bcd8739ae039 {
    }
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("default") => (w!("$abc$export$2e2bcd8739ae039"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    console.log(module);
    export default class X {}
    "#,
    );

    assert!(hoist.should_wrap);
    assert_eq!(
      code,
      indoc! {r#"
    console.log(module);
    class X {
    }
    "#}
    );

    assert_eq_exported_symbols!(hoist.exported_symbols, map! {});

    let (_collect, code, hoist) = parse(
      r#"
    export var x = 2, y = 3;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
      var $abc$export$d141bba7fdc215a3 = 2, $abc$export$4a5767248b18ef41 = 3;
      "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("x") => (w!("$abc$export$d141bba7fdc215a3"), true),
        w!("y") => (w!("$abc$export$4a5767248b18ef41"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export var {x, ...y} = something;
    export var [p, ...q] = something;
    export var {x = 3} = something;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var { x: $abc$export$d141bba7fdc215a3, ...$abc$export$4a5767248b18ef41 } = something;
    var [$abc$export$ffb5f4729a158638, ...$abc$export$9e5f44173e64f162] = something;
    var { x: $abc$export$d141bba7fdc215a3 = 3 } = something;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("x") => (w!("$abc$export$d141bba7fdc215a3"), true),
        w!("y") => (w!("$abc$export$4a5767248b18ef41"), true),
        w!("p") => (w!("$abc$export$ffb5f4729a158638"), true),
        w!("q") => (w!("$abc$export$9e5f44173e64f162"), true),
        w!("x") => (w!("$abc$export$d141bba7fdc215a3"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export function test() {}
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    function $abc$export$e0969da9b8fb378d() {}
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("test") => (w!("$abc$export$e0969da9b8fb378d"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export class Test {}
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    class $abc$export$1b16fc9eb974a84d {
    }
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("Test") => (w!("$abc$export$1b16fc9eb974a84d"), true)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    export {foo} from 'bar';
    "#,
    );

    assert_eq_exported_symbols!(hoist.exported_symbols, map! {});

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:bar:esm";
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    export * from 'bar';
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:bar:esm";
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    export { settings as siteSettings } from "./settings";
    export const settings = "hi";
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:./settings:esm";
    const $abc$export$a5a6e0b888b2c992 = "hi";
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("settings") => (w!("$abc$export$a5a6e0b888b2c992"), true)
      }
    );
    assert_eq_imported_symbols!(
      hoist.re_exports,
      map! {
        w!("siteSettings") => (w!("./settings"), w!("settings"))
      }
    );
  }

  #[test]
  fn fold_cjs_export() {
    let (_collect, code, hoist) = parse(
      r#"
    exports.foo = 2;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 2;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("foo") => (w!("$abc$export$6a5cdcad01c973fa"), false)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    exports['foo'] = 2;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 2;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("foo") => (w!("$abc$export$6a5cdcad01c973fa"), false)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    function init() {
      exports.foo = 2;
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    function $abc$var$init() {
        $abc$export$6a5cdcad01c973fa = 2;
    }
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("foo") => (w!("$abc$export$6a5cdcad01c973fa"), false)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    module.exports.foo = 2;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 2;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("foo") => (w!("$abc$export$6a5cdcad01c973fa"), false)
      }
    );

    let (_collect, code, hoist) = parse(
      r#"
    module.exports['foo'] = 2;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 2;
    "#}
    );

    assert_eq_exported_symbols!(
      hoist.exported_symbols,
      map! {
        w!("foo") => (w!("$abc$export$6a5cdcad01c973fa"), false)
      }
    );

    let (_collect, code, _hoist) = parse(
      r#"
    exports.foo = 2;
    console.log(exports.foo)
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 2;
    console.log($abc$export$6a5cdcad01c973fa);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    module.exports.foo = 2;
    console.log(module.exports.foo)
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 2;
    console.log($abc$export$6a5cdcad01c973fa);
    "#}
    );
  }

  #[test]
  fn fold_cjs_export_non_static() {
    let (_collect, code, _hoist) = parse(
      r#"
    exports[foo] = 2;
    exports.bar = 3;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports[foo] = 2;
    $abc$exports.bar = 3;
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    module.exports[foo] = 2;
    module.exports.bar = 3;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports[foo] = 2;
    $abc$exports.bar = 3;
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    exports.foo = 2;
    sideEffects(exports);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports.foo = 2;
    sideEffects($abc$exports);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    exports.foo = 2;
    sideEffects(module.exports);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports.foo = 2;
    sideEffects($abc$exports);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    exports[foo] = 2;
    console.log(exports[foo]);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports[foo] = 2;
    console.log($abc$exports[foo]);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    exports[foo] = 2;
    console.log(exports.foo);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports[foo] = 2;
    console.log($abc$exports.foo);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    module.exports[foo] = 2;
    console.log(module.exports[foo]);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports[foo] = 2;
    console.log($abc$exports[foo]);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    module.exports[foo] = 2;
    console.log(module.exports.foo);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    $abc$exports[foo] = 2;
    console.log($abc$exports.foo);
    "#}
    );

    let (_collect, code, _hoist) = parse(
      r#"
    var module = {exports: {}};
    module.exports.foo = 2;
    console.log(module.exports.foo);
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$var$module = {
        exports: {}
    };
    $abc$var$module.exports.foo = 2;
    console.log($abc$var$module.exports.foo);
    "#}
    );
  }

  #[test]
  fn test_parse_self_reference() {
    let (_collect, code, hoist) = parse(
      r#"
    exports.foo = 10;
    exports.something = function() {
       return exports.foo;
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    var $abc$export$ce14ccb78c97a7d4;
    $abc$export$6a5cdcad01c973fa = 10;
    $abc$export$ce14ccb78c97a7d4 = function() {
        return $abc$export$6a5cdcad01c973fa;
    };
    "#}
    );
    assert_eq!(
      hoist
        .self_references
        .iter()
        .cloned()
        .collect::<Vec<JsWord>>(),
      vec![JsWord::from("foo")]
    );
    assert_eq!(hoist.exported_symbols.len(), 3);
    // First exported symbol is `export foo`
    assert_eq!(
      hoist.exported_symbols[0].local,
      JsWord::from("$abc$export$6a5cdcad01c973fa")
    );
    assert_eq!(hoist.exported_symbols[0].exported, JsWord::from("foo"));

    // Second is `export something`
    assert_eq!(
      hoist.exported_symbols[1].local,
      JsWord::from("$abc$export$ce14ccb78c97a7d4")
    );
    assert_eq!(
      hoist.exported_symbols[1].exported,
      JsWord::from("something")
    );

    // Third is `export foo` again, but on the something location
    assert_eq!(
      hoist.exported_symbols[2].local,
      JsWord::from("$abc$export$6a5cdcad01c973fa")
    );
    assert_eq!(hoist.exported_symbols[2].exported, JsWord::from("foo"));

    assert_ne!(hoist.exported_symbols[2].loc, hoist.exported_symbols[0].loc);
  }

  #[test]
  fn test_parse_module_exports() {
    let (_collect, code, hoist) = parse(
      r#"
    module.exports.foo = 10;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 10;
    "#}
    );
    assert_eq!(hoist.self_references.len(), 0);
    assert_eq!(hoist.exported_symbols.len(), 1);
    assert_eq!(
      hoist.exported_symbols[0].local,
      JsWord::from("$abc$export$6a5cdcad01c973fa")
    );
    assert_eq!(hoist.exported_symbols[0].exported, JsWord::from("foo"));
  }

  #[test]
  fn test_parse_this() {
    let (_collect, code, hoist) = parse(
      r#"
    this.foo = 10;
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    var $abc$export$6a5cdcad01c973fa;
    $abc$export$6a5cdcad01c973fa = 10;
    "#}
    );
    assert_eq!(hoist.self_references.len(), 0);
    assert_eq!(hoist.exported_symbols.len(), 1);
    assert_eq!(
      hoist.exported_symbols[0].local,
      JsWord::from("$abc$export$6a5cdcad01c973fa")
    );
    assert_eq!(hoist.exported_symbols[0].exported, JsWord::from("foo"));
  }

  #[test]
  fn test_parse_import_statement() {
    let (_collect, code, hoist) = parse(
      r#"
    import { x } from 'other';
    async function test() {
      console.log(x.foo);
    }
    "#,
    );

    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other:esm";
    async function $abc$var$test() {
        console.log((0, $abc$import$70a00e0a8474f72a$d141bba7fdc215a3).foo);
    }
    "#}
    );
    assert_eq!(hoist.imported_symbols.len(), 1);
    assert_eq!(hoist.imported_symbols[0].imported, JsWord::from("x"));
    assert_eq!(
      hoist.imported_symbols[0].local,
      JsWord::from("$abc$import$70a00e0a8474f72a$d141bba7fdc215a3")
    );
    assert_eq!(hoist.imported_symbols[0].source, JsWord::from("other"));
    assert_eq!(hoist.imported_symbols[0].kind, ImportKind::Import);
  }

  #[test]
  fn fold_dynamic_import() {
    let (_collect, code, hoist) = parse(
      r#"
    async function test() {
      const x = await import('other');
      console.log(x.foo);
    }
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    async function $abc$var$test() {
        const x = await $abc$importAsync$70a00e0a8474f72a;
        console.log(x.foo);
    }
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    async function test() {
      const x = await import('other');
      console.log(x[foo]);
    }
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => (w!("other"), w!("*"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    async function $abc$var$test() {
        const x = await $abc$importAsync$70a00e0a8474f72a;
        console.log(x[foo]);
    }
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    async function test() {
      const {foo} = await import('other');
      console.log(foo);
    }
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    async function $abc$var$test() {
        const { foo: foo } = await $abc$importAsync$70a00e0a8474f72a;
        console.log(foo);
    }
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    async function test() {
      const {foo: bar} = await import('other');
      console.log(bar);
    }
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    async function $abc$var$test() {
        const { foo: bar } = await $abc$importAsync$70a00e0a8474f72a;
        console.log(bar);
    }
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(x => x.foo);
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then((x)=>x.foo);
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(x => x);
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => (w!("other"), w!("*"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then((x)=>x);
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(({foo}) => foo);
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then(({ foo: foo })=>foo);
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(({foo: bar}) => bar);
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then(({ foo: bar })=>bar);
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(function (x) { return x.foo });
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then(function(x) {
        return x.foo;
    });
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(function (x) { return x });
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => (w!("other"), w!("*"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then(function(x) {
        return x;
    });
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(function ({foo}) {});
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then(function({ foo: foo }) {});
    "#}
    );

    let (_collect, code, hoist) = parse(
      r#"
    import('other').then(function ({foo: bar}) {});
    "#,
    );
    assert_eq_imported_symbols!(
      hoist.imported_symbols,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a$6a5cdcad01c973fa") => (w!("other"), w!("foo"))
      }
    );
    assert_eq!(
      hoist.dynamic_imports,
      map! {
        w!("$abc$importAsync$70a00e0a8474f72a") => w!("other")
      }
    );
    assert_eq!(
      code,
      indoc! {r#"
    import "abc:other";
    $abc$importAsync$70a00e0a8474f72a.then(function({ foo: bar }) {});
    "#}
    );
  }

  #[test]
  fn fold_hoist_vars() {
    let (_collect, code, _hoist) = parse(
      r#"
    var x = 2;
    var y = {x};
    var z = {x: 3};
    var w = {[x]: 4};

    function test() {
      var x = 3;
    }
    "#,
    );
    assert_eq!(
      code,
      indoc! {r#"
    var $abc$var$x = 2;
    var $abc$var$y = {
        x: $abc$var$x
    };
    var $abc$var$z = {
        x: 3
    };
    var $abc$var$w = {
        [$abc$var$x]: 4
    };
    function $abc$var$test() {
        var x = 3;
    }
    "#}
    );
  }

  #[test]
  fn collect_exports() {
    let (collect, _code, _hoist) = parse("export default function () {};");
    assert_eq!(
      collect.exports,
      map! {
        w!("default") => Export {
          source: None,
          specifier: "default".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 30
          },
          is_esm: true
        }
      }
    );

    let (collect, _code, _hoist) = parse("export default function test () {};");
    assert_eq!(
      collect.exports,
      map! {
        w!("default") => Export {
          source: None,
          specifier: "test".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 35
          },
          is_esm: true
        }
      }
    );

    let (collect, _code, _hoist) = parse("export default class {};");
    assert_eq!(
      collect.exports,
      map! {
        w!("default") => Export {
          source: None,
          specifier: "default".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 24
          },
          is_esm: true
        }
      }
    );

    let (collect, _code, _hoist) = parse("export default class test {};");
    assert_eq!(
      collect.exports,
      map! {
        w!("default") => Export {
          source: None,
          specifier: "test".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 29
          },
          is_esm: true
        }
      }
    );

    let (collect, _code, _hoist) = parse("export default foo;");
    assert_eq!(
      collect.exports,
      map! {
        w!("default") => Export {
          source: None,
          specifier: "default".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 1,
            end_line: 1,
            end_col: 20
          },
          is_esm: true
        }
      }
    );

    let (collect, _code, _hoist) = parse("module.exports.foo = 2;");
    assert_eq!(
      collect.exports,
      map! {
        w!("foo") => Export {
          source: None,
          specifier: "foo".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 16,
            end_line: 1,
            end_col: 19
          },
          is_esm: false
        }
      }
    );

    let (collect, _code, _hoist) = parse("module.exports['foo'] = 2;");
    assert_eq!(
      collect.exports,
      map! {
        w!("foo") => Export {
          source: None,
          specifier: "foo".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 16,
            end_line: 1,
            end_col: 21
          },
          is_esm: false
        }
      }
    );

    let (collect, _code, _hoist) = parse("module.exports[`foo`] = 2;");
    assert_eq!(
      collect.exports,
      map! {
        w!("foo") => Export {
          source: None,
          specifier: "foo".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 16,
            end_line: 1,
            end_col: 21
          },
          is_esm: false
        }
      }
    );

    let (collect, _code, _hoist) = parse("exports.foo = 2;");
    assert_eq!(
      collect.exports,
      map! {
        w!("foo") => Export {
          source: None,
          specifier: "foo".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 9,
            end_line: 1,
            end_col: 12
          },
          is_esm: false
        }
      }
    );

    let (collect, _code, _hoist) = parse("this.foo = 2;");
    assert_eq!(
      collect.exports,
      map! {
        w!("foo") => Export {
          source: None,
          specifier: "foo".into(),
          loc: SourceLocation {
            start_line: 1,
            start_col: 6,
            end_line: 1,
            end_col: 9
          },
          is_esm: false
        }
      }
    );
  }

  #[test]
  fn collect_this_exports() {
    // module is wrapped when `this` accessor matches an export
    let (collect, _code, _hoist) = parse(
      r#"
      exports.foo = function() {
        exports.bar()
      }

      exports.bar = function() {
        this.baz()
      }

      exports.baz = function() {
        return 2
      }
      "#,
    );
    assert_eq!(
      collect
        .bailouts
        .unwrap()
        .iter()
        .map(|b| &b.reason)
        .collect::<Vec<_>>(),
      vec![&BailoutReason::ThisInExport]
    );
    assert!(collect.should_wrap);

    // module is not wrapped when `this` inside a class collides with an export
    let (collect, _code, _hoist) = parse(
      r#"
      class Foo {
        constructor() {
          this.a = 4
        }

        bar() {
          return this.baz()
        }

        baz() {
          return this.a
        }
      }

      exports.baz = new Foo()
      exports.a = 2
      "#,
    );
    assert_eq!(
      collect
        .bailouts
        .unwrap()
        .iter()
        .map(|b| &b.reason)
        .collect::<Vec<_>>(),
      Vec::<&BailoutReason>::new()
    );
    assert!(!collect.should_wrap);
  }
}
