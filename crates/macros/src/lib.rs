#![deny(unused_crate_dependencies)]

use std::{
  collections::{HashMap, HashSet},
  sync::Arc,
};
use swc_core::ecma::utils::stack_size::maybe_grow_default;

use indexmap::IndexMap;
use swc_core::{
  common::{sync::Lrc, util::take::Take, SourceMap, Span, DUMMY_SP},
  ecma::{
    ast::*,
    atoms::{js_word, JsWord},
    parser::{error::Error, lexer::Lexer, Parser, StringInput},
    visit::{Fold, FoldWith},
  },
};

#[cfg(feature = "napi")]
pub mod napi;

#[derive(PartialEq)]
pub enum MacroError {
  /// Could not statically evaluate macro argument.
  EvaluationError(Span),
  /// An error occurred loading a macro (e.g. resolution or syntax error).
  LoadError(String, Span),
  /// An error was thrown when executing a macro.
  ExecutionError(String, Span),
  /// Could not parse the result of a function returned by a macro.
  ParseError(Error),
}

#[derive(serde::Serialize)]
pub struct Location {
  pub line: u32,
  pub col: u32,
}

pub type MacroCallback =
  Arc<dyn Fn(String, String, Vec<JsValue>, Location) -> Result<JsValue, MacroError> + Send + Sync>;

pub struct Macros<'a> {
  /// Mapping of imported identifiers to import metadata.
  macros: HashMap<Id, MacroImport>,
  constants: HashMap<Id, Result<JsValue, Span>>,
  callback: MacroCallback,
  source_map: &'a SourceMap,
  errors: &'a mut Vec<MacroError>,
  load_errors: HashSet<String>,
  assignment_span: Option<Span>,
  in_call: bool,
}

struct MacroImport {
  /// The import specifier.
  src: JsWord,
  /// The imported identifier. None if this is a namespace import.
  imported: Option<JsWord>,
  /// The location of the import specifier.
  span: Span,
}

impl<'a> Macros<'a> {
  pub fn new(
    callback: MacroCallback,
    source_map: &'a SourceMap,
    errors: &'a mut Vec<MacroError>,
  ) -> Self {
    Macros {
      macros: HashMap::new(),
      constants: HashMap::new(),
      load_errors: HashSet::new(),
      callback,
      source_map,
      errors,
      assignment_span: None,
      in_call: false,
    }
  }

  fn add_macro(&mut self, import: &ImportDecl) {
    for specifier in &import.specifiers {
      match specifier {
        ImportSpecifier::Named(named) => {
          let imported = match &named.imported {
            Some(ModuleExportName::Ident(id)) => id.sym.clone(),
            Some(ModuleExportName::Str(s)) => s.value.clone(),
            None => named.local.sym.clone(),
          };
          self.macros.insert(
            named.local.to_id(),
            MacroImport {
              src: import.src.value.clone(),
              imported: Some(imported),
              span: import.span,
            },
          );
        }
        ImportSpecifier::Default(default) => {
          self.macros.insert(
            default.local.to_id(),
            MacroImport {
              src: import.src.value.clone(),
              imported: Some(js_word!("default")),
              span: import.span,
            },
          );
        }
        ImportSpecifier::Namespace(namespace) => {
          self.macros.insert(
            namespace.local.to_id(),
            MacroImport {
              src: import.src.value.clone(),
              imported: None,
              span: import.span,
            },
          );
        }
      }
    }
  }

  fn call_macro(
    &mut self,
    src: String,
    export: String,
    call: CallExpr,
    import_span: Span,
  ) -> Result<Expr, MacroError> {
    // If a macro already errorered during loading, don't try calling it again.
    if self.load_errors.contains(&src) {
      return Ok(Expr::Lit(Lit::Null(Null::dummy())));
    }

    // Try to statically evaluate all of the function arguments.
    let mut args = Vec::with_capacity(call.args.len());
    for arg in &call.args {
      match self.eval(&*arg.expr) {
        Ok(val) => {
          if arg.spread.is_none() {
            args.push(val);
          } else if let JsValue::Array(val) = val {
            args.extend(val);
          } else {
            return Err(MacroError::EvaluationError(call.span));
          }
        }
        Err(span) => {
          return Err(MacroError::EvaluationError(span));
        }
      }
    }

    // If that was successful, call the function callback (on the JS thread).
    let loc = self.source_map.lookup_char_pos(call.span.lo);
    let loc = Location {
      line: loc.line as u32,
      col: loc.col_display as u32,
    };
    match (self.callback)(src.clone(), export, args, loc) {
      Ok(val) => Ok(self.value_to_expr(val)?),
      Err(err) => match err {
        MacroError::LoadError(err, _) => {
          self.load_errors.insert(src);
          Err(MacroError::LoadError(err, import_span))
        }
        MacroError::ExecutionError(err, _) => Err(MacroError::ExecutionError(err, call.span)),
        err => Err(err),
      },
    }
  }
}

impl<'a> Fold for Macros<'a> {
  fn fold_module(&mut self, mut node: Module) -> Module {
    // Pre-pass to find all macro imports.
    node.body.retain(|item| {
      if let ModuleItem::ModuleDecl(decl) = &item {
        if let ModuleDecl::Import(import) = &decl {
          if matches!(&import.with, Some(with) if is_macro(with)) {
            self.add_macro(import);
            return false;
          }
        }
      }

      true
    });

    // Only process the rest of the AST if we found any macro imports.
    if !self.macros.is_empty() {
      node = node.fold_children_with(self);
    }

    node
  }

  fn fold_expr(&mut self, node: Expr) -> Expr {
    if let Expr::Call(call) = node {
      if let Callee::Expr(expr) = &call.callee {
        match &**expr {
          Expr::Ident(ident) => {
            if let Some(specifier) = self.macros.get(&ident.to_id()) {
              if let Some(imported) = &specifier.imported {
                let src = specifier.src.to_string();
                let imported = imported.to_string();
                let span = specifier.span;
                let in_call = std::mem::take(&mut self.in_call);
                let call = call.fold_with(self);
                self.in_call = in_call;
                return handle_error(self.call_macro(src, imported, call, span), &mut self.errors);
              }
            }
          }
          Expr::Member(member) => 'block: {
            // e.g. ns.macro()
            if let Expr::Ident(ident) = &*member.obj {
              // Check that this is a namespace import.
              if let Some(specifier @ MacroImport { imported: None, .. }) =
                self.macros.get(&ident.to_id())
              {
                let imported = match &member.prop {
                  MemberProp::Ident(id) => id.sym.to_string(),
                  MemberProp::Computed(s) => {
                    if let Ok(JsValue::String(s)) = self.eval(&s.expr) {
                      s
                    } else {
                      break 'block;
                    }
                  }
                  MemberProp::PrivateName(_) => break 'block,
                };

                let src = specifier.src.to_string();
                let span = specifier.span;
                let in_call = std::mem::take(&mut self.in_call);
                let call = call.fold_with(self);
                self.in_call = in_call;
                return handle_error(self.call_macro(src, imported, call, span), &mut self.errors);
              }
            }
          }
          _ => {}
        }
      }

      // Not a macro. Track if we're in a call so we can error if constant
      // objects are referenced that might be mutated.
      self.in_call = true;
      let call = call.fold_with(self);
      self.in_call = false;
      return Expr::Call(call);
    }

    maybe_grow_default(|| node.fold_children_with(self))
  }

  fn fold_var_decl(&mut self, mut node: VarDecl) -> VarDecl {
    node = node.fold_children_with(self);

    if node.kind == VarDeclKind::Const {
      for decl in &node.decls {
        if let Some(expr) = &decl.init {
          let val = self.eval(&*expr);
          self.eval_pat(val, &decl.name);
        }
      }
    }

    node
  }

  fn fold_assign_expr(&mut self, mut node: AssignExpr) -> AssignExpr {
    self.assignment_span = Some(node.span.clone());
    node.left = node.left.fold_with(self);
    self.assignment_span = None;

    node.right = node.right.fold_with(self);
    node
  }

  fn fold_member_expr(&mut self, node: MemberExpr) -> MemberExpr {
    if let Some(assignment_span) = self.assignment_span {
      // Error when re-assigning a property of a constant that's used in a macro.
      let node = node.fold_children_with(self);
      if let Expr::Ident(id) = &*node.obj {
        if let Some(constant) = self.constants.get_mut(&id.to_id()) {
          if constant.is_ok() {
            *constant = Err(assignment_span.clone());
          }
        }
      }

      return node;
    } else if self.in_call {
      // We need to error when passing a constant object into a non-macro call, since it might be mutated.
      // If the member expression evaluates to an object, continue traversing so we error in fold_ident.
      // Otherwise, return early to allow other properties to be accessed without error.
      let value = self
        .eval(&*node.obj)
        .and_then(|obj| self.eval_member_prop(obj, &node));
      if !matches!(
        value,
        Err(..) | Ok(JsValue::Object(..) | JsValue::Array(..))
      ) {
        return node;
      }
    }

    node.fold_children_with(self)
  }

  fn fold_ident(&mut self, node: Ident) -> Ident {
    if self.in_call {
      if let Some(constant) = self.constants.get_mut(&node.to_id()) {
        if matches!(constant, Ok(JsValue::Object(..) | JsValue::Array(..))) {
          // Mark access to constant object inside a call as an error since it could potentially be mutated.
          *constant = Err(node.span.clone());
        }
      }
    }

    node
  }
}

/// Checks if an object literal (from import attributes) has type: 'macro'.
fn is_macro(with: &ObjectLit) -> bool {
  for prop in &with.props {
    if let PropOrSpread::Prop(prop) = &prop {
      if let Prop::KeyValue(kv) = &**prop {
        let k = match &kv.key {
          PropName::Ident(IdentName { sym, .. }) | PropName::Str(Str { value: sym, .. }) => {
            sym.clone()
          }
          _ => continue,
        };
        if &k == "type"
          && matches!(&*kv.value, Expr::Lit(Lit::Str(Str { value, .. })) if value == "macro")
        {
          return true;
        }
      }
    }
  }

  false
}

fn handle_error(result: Result<Expr, MacroError>, errors: &mut Vec<MacroError>) -> Expr {
  match result {
    Ok(expr) => expr,
    Err(err) => {
      if !errors.iter().any(|d| *d == err) {
        errors.push(err);
      }
      Expr::Lit(Lit::Null(Null::dummy()))
    }
  }
}

/// A type that represents a basic JS value.
#[derive(Clone, Debug)]
pub enum JsValue {
  Undefined,
  Null,
  Bool(bool),
  Number(f64),
  String(String),
  Regex { source: String, flags: String },
  Array(Vec<JsValue>),
  Object(IndexMap<String, JsValue>),
  Function(String),
}

impl<'a> Macros<'a> {
  /// Statically evaluate a JS expression to a value, if possible.
  fn eval(&self, expr: &Expr) -> Result<JsValue, Span> {
    match expr.unwrap_parens() {
      Expr::Lit(lit) => match lit {
        Lit::Null(_) => Ok(JsValue::Null),
        Lit::Bool(v) => Ok(JsValue::Bool(v.value)),
        Lit::Num(v) => Ok(JsValue::Number(v.value)),
        Lit::Str(v) => Ok(JsValue::String(v.value.to_string())),
        Lit::JSXText(v) => Ok(JsValue::String(v.value.to_string())),
        Lit::Regex(v) => Ok(JsValue::Regex {
          source: v.exp.to_string(),
          flags: v.flags.to_string(),
        }),
        Lit::BigInt(v) => Err(v.span),
      },
      Expr::Tpl(tpl) => {
        let exprs: Vec<_> = tpl
          .exprs
          .iter()
          .filter_map(|expr| self.eval(&*expr).ok())
          .collect();
        if exprs.len() == tpl.exprs.len() {
          let mut res = String::new();
          let mut expr_iter = exprs.iter();
          for quasi in &tpl.quasis {
            res.push_str(&quasi.raw);
            match expr_iter.next() {
              None => {}
              Some(JsValue::String(s)) => res.push_str(s),
              Some(JsValue::Number(n)) => res.push_str(&n.to_string()),
              Some(JsValue::Bool(b)) => res.push_str(&b.to_string()),
              _ => return Err(tpl.span),
            }
          }

          Ok(JsValue::String(res))
        } else {
          Err(tpl.span)
        }
      }
      Expr::Array(arr) => {
        let mut res = Vec::with_capacity(arr.elems.len());
        for elem in &arr.elems {
          if let Some(elem) = elem {
            let val = self.eval(&*elem.expr)?;
            if elem.spread.is_some() {
              match val {
                JsValue::Array(arr) => {
                  res.extend(arr);
                }
                _ => return Err(arr.span),
              }
            } else {
              res.push(val);
            }
          } else {
            res.push(JsValue::Undefined);
          }
        }
        Ok(JsValue::Array(res))
      }
      Expr::Object(obj) => {
        let mut res = IndexMap::with_capacity(obj.props.len());
        for prop in &obj.props {
          match prop {
            PropOrSpread::Prop(prop) => match &**prop {
              Prop::KeyValue(kv) => {
                let v = self.eval(&*kv.value)?;
                let k = match &kv.key {
                  PropName::Ident(IdentName { sym, .. })
                  | PropName::Str(Str { value: sym, .. }) => sym.to_string(),
                  PropName::Num(n) => n.value.to_string(),
                  PropName::Computed(c) => match self.eval(&*c.expr) {
                    Err(e) => return Err(e),
                    Ok(JsValue::String(s)) => s,
                    Ok(JsValue::Number(n)) => n.to_string(),
                    Ok(JsValue::Bool(b)) => b.to_string(),
                    _ => return Err(c.span),
                  },
                  PropName::BigInt(v) => return Err(v.span),
                };

                res.insert(k.to_string(), v);
              }
              Prop::Shorthand(s) => {
                if let Some(val) = self.constants.get(&s.to_id()) {
                  res.insert(s.sym.to_string(), val.clone()?);
                } else {
                  return Err(s.span);
                }
              }
              _ => return Err(obj.span),
            },
            PropOrSpread::Spread(spread) => {
              let v = self.eval(&*spread.expr)?;
              match v {
                JsValue::Object(o) => res.extend(o),
                _ => return Err(obj.span),
              }
            }
          }
        }
        Ok(JsValue::Object(res))
      }
      Expr::Bin(bin) => match (bin.op, self.eval(&*bin.left), self.eval(&*bin.right)) {
        (BinaryOp::Add, Ok(JsValue::String(a)), Ok(JsValue::String(b))) => {
          Ok(JsValue::String(format!("{}{}", a, b)))
        }
        (BinaryOp::Add, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(a + b))
        }
        (BinaryOp::Add, Ok(JsValue::String(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::String(format!("{}{}", a, b)))
        }
        (BinaryOp::Add, Ok(JsValue::Number(a)), Ok(JsValue::String(b))) => {
          Ok(JsValue::String(format!("{}{}", a, b)))
        }
        (BinaryOp::BitAnd, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(((a as i32) & (b as i32)) as f64))
        }
        (BinaryOp::BitOr, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(((a as i32) | (b as i32)) as f64))
        }
        (BinaryOp::BitXor, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(((a as i32) ^ (b as i32)) as f64))
        }
        (BinaryOp::LShift, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(((a as i32) << (b as i32)) as f64))
        }
        (BinaryOp::RShift, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(((a as i32) >> (b as i32)) as f64))
        }
        (BinaryOp::ZeroFillRShift, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(((a as i32) >> (b as u32)) as f64))
        }
        (BinaryOp::Sub, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(a - b))
        }
        (BinaryOp::Div, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(a / b))
        }
        (BinaryOp::Mul, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(a * b))
        }
        (BinaryOp::Mod, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(a % b))
        }
        (BinaryOp::Exp, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Number(a.powf(b)))
        }
        (BinaryOp::EqEq, Ok(JsValue::Bool(a)), Ok(JsValue::Bool(b))) => Ok(JsValue::Bool(a == b)),
        (BinaryOp::EqEqEq, Ok(JsValue::Bool(a)), Ok(JsValue::Bool(b))) => Ok(JsValue::Bool(a == b)),
        (BinaryOp::NotEq, Ok(JsValue::Bool(a)), Ok(JsValue::Bool(b))) => Ok(JsValue::Bool(a != b)),
        (BinaryOp::NotEqEq, Ok(JsValue::Bool(a)), Ok(JsValue::Bool(b))) => {
          Ok(JsValue::Bool(a != b))
        }
        (BinaryOp::EqEq, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Bool(a == b))
        }
        (BinaryOp::EqEqEq, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Bool(a == b))
        }
        (BinaryOp::NotEq, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Bool(a != b))
        }
        (BinaryOp::NotEqEq, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Bool(a != b))
        }
        (BinaryOp::EqEq, Ok(JsValue::String(a)), Ok(JsValue::String(b))) => {
          Ok(JsValue::Bool(a == b))
        }
        (BinaryOp::EqEqEq, Ok(JsValue::String(a)), Ok(JsValue::String(b))) => {
          Ok(JsValue::Bool(a == b))
        }
        (BinaryOp::NotEq, Ok(JsValue::String(a)), Ok(JsValue::String(b))) => {
          Ok(JsValue::Bool(a != b))
        }
        (BinaryOp::NotEqEq, Ok(JsValue::String(a)), Ok(JsValue::String(b))) => {
          Ok(JsValue::Bool(a != b))
        }
        (BinaryOp::Gt, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => Ok(JsValue::Bool(a > b)),
        (BinaryOp::GtEq, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Bool(a >= b))
        }
        (BinaryOp::Lt, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => Ok(JsValue::Bool(a < b)),
        (BinaryOp::LtEq, Ok(JsValue::Number(a)), Ok(JsValue::Number(b))) => {
          Ok(JsValue::Bool(a <= b))
        }
        (BinaryOp::LogicalAnd, Ok(JsValue::Bool(a)), Ok(JsValue::Bool(b))) => {
          Ok(JsValue::Bool(a && b))
        }
        (BinaryOp::LogicalOr, Ok(JsValue::Bool(a)), Ok(JsValue::Bool(b))) => {
          Ok(JsValue::Bool(a || b))
        }
        (BinaryOp::NullishCoalescing, Ok(JsValue::Null | JsValue::Undefined), Ok(b)) => Ok(b),
        (BinaryOp::NullishCoalescing, Ok(a), Ok(_)) => Ok(a),
        _ => Err(bin.span),
      },
      Expr::Unary(unary) => match (unary.op, self.eval(&*unary.arg)) {
        (UnaryOp::Bang, Ok(JsValue::Bool(v))) => Ok(JsValue::Bool(!v)),
        (UnaryOp::Minus, Ok(JsValue::Number(v))) => Ok(JsValue::Number(-v)),
        (UnaryOp::Plus, Ok(JsValue::Number(v))) => Ok(JsValue::Number(v)),
        (UnaryOp::Plus, Ok(JsValue::String(v))) => {
          if let Ok(v) = v.parse() {
            Ok(JsValue::Number(v))
          } else {
            Err(unary.span)
          }
        }
        (UnaryOp::Tilde, Ok(JsValue::Number(v))) => Ok(JsValue::Number((!(v as i32)) as f64)),
        (UnaryOp::Void, Ok(_)) => Ok(JsValue::Undefined),
        (UnaryOp::TypeOf, Ok(JsValue::Bool(_))) => Ok(JsValue::String("boolean".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::Number(_))) => Ok(JsValue::String("number".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::String(_))) => Ok(JsValue::String("string".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::Object(_))) => Ok(JsValue::String("object".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::Array(_))) => Ok(JsValue::String("object".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::Regex { .. })) => Ok(JsValue::String("object".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::Null)) => Ok(JsValue::String("object".to_string())),
        (UnaryOp::TypeOf, Ok(JsValue::Undefined)) => Ok(JsValue::String("undefined".to_string())),
        _ => Err(unary.span),
      },
      Expr::Cond(cond) => match self.eval(&*&cond.test) {
        Ok(JsValue::Bool(v)) => {
          if v {
            self.eval(&*&cond.cons)
          } else {
            self.eval(&*cond.alt)
          }
        }
        Ok(JsValue::Null) | Ok(JsValue::Undefined) => self.eval(&*cond.alt),
        Ok(JsValue::Object(_))
        | Ok(JsValue::Array(_))
        | Ok(JsValue::Function(_))
        | Ok(JsValue::Regex { .. }) => self.eval(&*cond.cons),
        Ok(JsValue::String(s)) => {
          if s.is_empty() {
            self.eval(&*cond.alt)
          } else {
            self.eval(&*cond.cons)
          }
        }
        Ok(JsValue::Number(n)) => {
          if n == 0.0 {
            self.eval(&*cond.alt)
          } else {
            self.eval(&*cond.cons)
          }
        }
        Err(e) => Err(e),
      },
      Expr::Ident(id) if &id.sym == "undefined" => Ok(JsValue::Undefined),
      Expr::Ident(id) => {
        if let Some(val) = self.constants.get(&id.to_id()) {
          val.clone()
        } else {
          Err(id.span)
        }
      }
      Expr::Member(member) => {
        let obj = self.eval(&*member.obj)?;
        self.eval_member_prop(obj, &member)
      }
      Expr::OptChain(opt) => {
        if let OptChainBase::Member(member) = &*opt.base {
          let obj = self.eval(&*member.obj)?;
          match obj {
            JsValue::Undefined | JsValue::Null => Ok(JsValue::Undefined),
            _ => self.eval_member_prop(obj, &member),
          }
        } else {
          Err(opt.span)
        }
      }
      Expr::TsAs(TsAsExpr { expr, .. })
      | Expr::TsNonNull(TsNonNullExpr { expr, .. })
      | Expr::TsSatisfies(TsSatisfiesExpr { expr, .. })
      | Expr::TsTypeAssertion(TsTypeAssertion { expr, .. })
      | Expr::TsInstantiation(TsInstantiation { expr, .. })
      | Expr::TsConstAssertion(TsConstAssertion { expr, .. }) => self.eval(expr),
      Expr::Fn(FnExpr { function, .. }) => Err(function.span),
      Expr::Class(ClassExpr { class, .. }) => Err(class.span),
      Expr::JSXElement(el) => Err(el.span),
      Expr::This(ThisExpr { span, .. })
      | Expr::Update(UpdateExpr { span, .. })
      | Expr::Assign(AssignExpr { span, .. })
      | Expr::Call(CallExpr { span, .. })
      | Expr::New(NewExpr { span, .. })
      | Expr::Seq(SeqExpr { span, .. })
      | Expr::TaggedTpl(TaggedTpl { span, .. })
      | Expr::Arrow(ArrowExpr { span, .. })
      | Expr::Yield(YieldExpr { span, .. })
      | Expr::Await(AwaitExpr { span, .. })
      | Expr::JSXFragment(JSXFragment { span, .. })
      | Expr::PrivateName(PrivateName { span, .. })
      | Expr::SuperProp(SuperPropExpr { span, .. })
      | Expr::MetaProp(MetaPropExpr { span, .. }) => Err(*span),
      _ => Err(DUMMY_SP),
    }
  }

  fn eval_member_prop(&self, obj: JsValue, member: &MemberExpr) -> Result<JsValue, Span> {
    match &member.prop {
      MemberProp::Ident(id) => obj.get_id(id.as_ref()).ok_or(member.span),
      MemberProp::Computed(prop) => {
        let k = self.eval(&*prop.expr)?;
        obj.get(&k).ok_or(prop.span)
      }
      _ => Err(member.span),
    }
  }

  /// Convert JS value to AST.
  fn value_to_expr(&self, value: JsValue) -> Result<Expr, MacroError> {
    Ok(match value {
      JsValue::Null => Expr::Lit(Lit::Null(Null::dummy())),
      JsValue::Undefined => Expr::Ident(Ident::new_no_ctxt(js_word!("undefined"), DUMMY_SP)),
      JsValue::Bool(b) => Expr::Lit(Lit::Bool(Bool {
        value: b,
        span: DUMMY_SP,
      })),
      JsValue::Number(n) => Expr::Lit(Lit::Num(Number {
        value: n,
        span: DUMMY_SP,
        raw: None,
      })),
      JsValue::String(s) => Expr::Lit(Lit::Str(Str {
        span: DUMMY_SP,
        value: s.into(),
        raw: None,
      })),
      JsValue::Regex { source, flags } => Expr::Lit(Lit::Regex(Regex {
        span: DUMMY_SP,
        exp: source.into(),
        flags: flags.into(),
      })),
      JsValue::Array(arr) => Expr::Array(ArrayLit {
        span: DUMMY_SP,
        elems: arr
          .into_iter()
          .map(|elem| -> Result<_, MacroError> {
            Ok(Some(ExprOrSpread {
              spread: None,
              expr: Box::new(self.value_to_expr(elem)?),
            }))
          })
          .collect::<Result<Vec<_>, MacroError>>()?,
      }),
      JsValue::Object(obj) => Expr::Object(ObjectLit {
        span: DUMMY_SP,
        props: obj
          .into_iter()
          .map(|(k, v)| -> Result<_, MacroError> {
            Ok(PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
              key: if Ident::verify_symbol(&k).is_ok() {
                PropName::Ident(IdentName::new(k.into(), DUMMY_SP))
              } else {
                PropName::Str(Str {
                  value: k.into(),
                  span: DUMMY_SP,
                  raw: None,
                })
              },
              value: Box::new(self.value_to_expr(v)?),
            }))))
          })
          .collect::<Result<Vec<_>, MacroError>>()?,
      }),
      JsValue::Function(source) => {
        let source_file = self.source_map.new_source_file(
          Lrc::new(swc_core::common::FileName::MacroExpansion),
          source.into(),
        );
        let lexer = Lexer::new(
          Default::default(),
          Default::default(),
          StringInput::from(&*source_file),
          None,
        );

        let mut parser = Parser::new_from(lexer);
        match parser.parse_expr() {
          Ok(expr) => *expr,
          Err(err) => return Err(MacroError::ParseError(err)),
        }
      }
    })
  }

  fn eval_pat(&mut self, value: Result<JsValue, Span>, pat: &Pat) {
    match pat {
      Pat::Ident(name) => {
        self.constants.insert(name.to_id(), value);
      }
      Pat::Array(arr) => {
        for (index, elem) in arr.elems.iter().enumerate() {
          if let Some(elem) = elem {
            match elem {
              Pat::Array(ArrayPat { span, .. })
              | Pat::Object(ObjectPat { span, .. })
              | Pat::Ident(BindingIdent {
                id: Ident { span, .. },
                ..
              }) => self.eval_pat(
                value
                  .as_ref()
                  .and_then(|v| v.get_index(index).ok_or(span))
                  .map_err(|s| *s),
                elem,
              ),
              Pat::Rest(rest) => self.eval_pat(
                value
                  .as_ref()
                  .and_then(|v| v.rest(index).ok_or(&rest.span))
                  .map_err(|s| *s),
                &*rest.arg,
              ),
              Pat::Assign(assign) => self.eval_pat(
                value.as_ref().map_err(|e| *e).and_then(|v| {
                  v.get_index(index)
                    .ok_or(assign.span)
                    .or_else(|_| self.eval(&*assign.right))
                }),
                &*assign.left,
              ),
              _ => {}
            }
          }
        }
      }
      Pat::Object(obj) => {
        let mut consumed = HashSet::new();
        for prop in &obj.props {
          match prop {
            ObjectPatProp::KeyValue(kv) => {
              let val = value
                .as_ref()
                .map_err(|e| *e)
                .and_then(|value| match &kv.key {
                  PropName::Ident(id) => {
                    consumed.insert(id.sym.clone());
                    value.get_id(id.sym.as_str()).ok_or(id.span)
                  }
                  PropName::Str(s) => {
                    consumed.insert(s.value.clone());
                    value.get_id(s.value.as_str()).ok_or(s.span)
                  }
                  PropName::Num(n) => {
                    consumed.insert(n.value.to_string().into());
                    value.get_index(n.value as usize).ok_or(n.span)
                  }
                  PropName::Computed(c) => {
                    let k = &self.eval(&*c.expr)?;
                    match k {
                      JsValue::String(s) => {
                        consumed.insert(s.clone().into());
                      }
                      JsValue::Number(n) => {
                        consumed.insert(n.to_string().into());
                      }
                      _ => {}
                    }
                    value.get(&k).ok_or(c.span)
                  }
                  PropName::BigInt(v) => Err(v.span),
                });
              self.eval_pat(val, &*kv.value)
            }
            ObjectPatProp::Assign(assign) => {
              let val = value.as_ref().map_err(|e| *e).and_then(|value| {
                value
                  .get_id(assign.key.sym.as_str())
                  .ok_or(assign.span)
                  .or_else(|_| {
                    assign
                      .value
                      .as_ref()
                      .map_or(Err(assign.span), |v| self.eval(&*v))
                  })
              });
              self.constants.insert(assign.key.to_id(), val);
              consumed.insert(assign.key.sym.clone());
            }
            ObjectPatProp::Rest(rest) => {
              let val = value.as_ref().map_err(|e| *e).and_then(|value| {
                if let JsValue::Object(obj) = value {
                  let filtered = obj
                    .iter()
                    .filter(|(k, _)| !consumed.contains(&k.as_str().into()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect();
                  Ok(JsValue::Object(filtered))
                } else {
                  Err(rest.span)
                }
              });
              self.eval_pat(val, &*rest.arg);
            }
          }
        }
      }
      _ => {}
    }
  }
}

impl JsValue {
  fn get(&self, prop: &JsValue) -> Option<JsValue> {
    match self {
      JsValue::Array(arr) => {
        if let JsValue::Number(n) = prop {
          arr.get(*n as usize).cloned()
        } else {
          None
        }
      }
      JsValue::Object(_) => match prop {
        JsValue::Number(n) => {
          let index = n.to_string();
          self.get_id(&index)
        }
        JsValue::String(s) => self.get_id(s),
        _ => None,
      },
      JsValue::String(s) => match prop {
        JsValue::String(prop) => self.get_id(prop),
        JsValue::Number(n) => s
          .get(*n as usize..=*n as usize)
          .map(|c| JsValue::String(c.to_owned())),
        _ => None,
      },
      _ => None,
    }
  }

  fn get_index(&self, index: usize) -> Option<JsValue> {
    if let JsValue::Array(arr) = self {
      arr.get(index).cloned()
    } else {
      None
    }
  }

  fn get_id(&self, prop: &str) -> Option<JsValue> {
    match self {
      JsValue::Object(obj) => obj.get(prop).cloned(),
      JsValue::String(s) => match prop {
        "length" => Some(JsValue::Number(s.len() as f64)),
        _ => None,
      },
      _ => None,
    }
  }

  fn rest(&self, index: usize) -> Option<JsValue> {
    if let JsValue::Array(arr) = self {
      arr.get(index..).map(|s| JsValue::Array(s.to_vec()))
    } else {
      None
    }
  }
}
