use swc_core::{
  common::Mark,
  ecma::{
    ast::{Expr, Lit, Str, UnaryOp},
    atoms::js_word,
    visit::{VisitMut, VisitMutWith},
  },
};

use crate::utils::is_unresolved;

/// Replaces `typeof module`, `typeof exports` and `typeof require` unary operator expressions
/// with the resulting string literals.
///
/// Requires `unresolved_mark` as passed into `swc_ecma_transform_base::resolver`, which is a mark
/// the SWC transformer will add into variables that are NOT shadowed. This means the `typeof`
/// expression will be replaced at build time with the resulting literal only if it's referring to
/// the global `module`, `exports` and `require` symbols.
pub struct TypeofReplacer {
  unresolved_mark: Mark,
}

impl TypeofReplacer {
  pub fn new(unresolved_mark: Mark) -> Self {
    Self { unresolved_mark }
  }
}

impl TypeofReplacer {
  /// Given an expression, optionally return a replacement if it happens to be `typeof $symbol` for
  /// the constants supported in this transformation step (`require`, `exports` and `module`).
  fn get_replacement(&mut self, node: &Expr) -> Option<Expr> {
    let Expr::Unary(ref unary) = node else {
      return None;
    };
    if unary.op != UnaryOp::TypeOf {
      return None;
    }
    // typeof require -> "function"
    // typeof module -> "object"
    let Expr::Ident(ident) = &*unary.arg else {
      return None;
    };

    if ident.sym == js_word!("require") && is_unresolved(&ident, self.unresolved_mark) {
      return Some(Expr::Lit(Lit::Str(Str {
        span: unary.span,
        value: js_word!("function"),
        raw: None,
      })));
    }

    if &*ident.sym == "exports" && is_unresolved(&ident, self.unresolved_mark) {
      return Some(Expr::Lit(Lit::Str(Str {
        span: unary.span,
        value: js_word!("object"),
        raw: None,
      })));
    }

    if ident.sym == js_word!("module") && is_unresolved(&ident, self.unresolved_mark) {
      return Some(Expr::Lit(Lit::Str(Str {
        span: unary.span,
        value: js_word!("object"),
        raw: None,
      })));
    }

    None
  }
}

impl VisitMut for TypeofReplacer {
  fn visit_mut_expr(&mut self, node: &mut Expr) {
    let Some(replacement) = self.get_replacement(node) else {
      node.visit_mut_children_with(self);
      return;
    };

    *node = replacement;
  }
}

#[cfg(test)]
mod test {
  use crate::test_utils::run_visit;

  use super::*;

  #[test]
  fn test_visitor_typeof_replacer_without_shadowing() {
    let code = r#"
const x = typeof require;
const m = typeof module;
const e = typeof exports;
"#;

    let output_code = run_visit(code, |context| TypeofReplacer {
      unresolved_mark: context.unresolved_mark,
    })
    .output_code;

    let expected_code = r#"
const x = "function";
const m = "object";
const e = "object";
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  #[test]
  fn test_typeof_nested_expression() {
    let code = r#"
const x = typeof require === 'function';
"#;

    let output_code = run_visit(code, |context| TypeofReplacer {
      unresolved_mark: context.unresolved_mark,
    })
    .output_code;

    let expected_code = r#"
const x = "function" === 'function';
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }

  #[test]
  fn test_visitor_typeof_replacer_with_shadowing() {
    let code = r#"
function wrapper({ require, exports }) {
    const x = typeof require;
    const m = typeof module;
    const e = typeof exports;
}
    "#;

    let output_code = run_visit(code, |context| TypeofReplacer {
      unresolved_mark: context.unresolved_mark,
    })
    .output_code;

    let expected_code = r#"
function wrapper({ require, exports }) {
    const x = typeof require;
    const m = "object";
    const e = typeof exports;
}
"#
    .trim_start();
    assert_eq!(output_code, expected_code);
  }
}
