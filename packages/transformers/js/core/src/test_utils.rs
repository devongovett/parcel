use swc_core::{
  common::{
    input::StringInput, sync::Lrc, util::take::Take, FileName, Globals, Mark, SourceMap, GLOBALS,
  },
  ecma::{
    ast::Module,
    codegen::text_writer::JsWriter,
    parser::{lexer::Lexer, Parser},
    transforms::base::resolver,
    visit::{Fold, FoldWith, VisitMut, VisitMutWith},
  },
};

pub(crate) struct RunTestContext {
  /// Source-map in use
  pub source_map: Lrc<SourceMap>,
  /// Global mark from SWC resolver
  pub global_mark: Mark,
  /// Unresolved mark from SWC resolver
  pub unresolved_mark: Mark,
}

pub(crate) struct RunVisitResult<V> {
  pub output_code: String,
  #[allow(unused)]
  pub visitor: V,
}

/// Helper to test SWC visitors.
///
/// * Parse `code` with SWC
/// * Run a visitor over it
/// * Return the result
///
pub(crate) fn run_visit<V: VisitMut>(
  code: &str,
  make_visit: impl FnOnce(RunTestContext) -> V,
) -> RunVisitResult<V> {
  let (output_code, visitor) = run_with_transformation(
    code,
    |run_test_context: RunTestContext, module: &mut Module| {
      let mut visit = make_visit(run_test_context);
      module.visit_mut_with(&mut visit);
      visit
    },
  );
  RunVisitResult {
    output_code,
    visitor,
  }
}

/// Same as `run_visit` but for `Fold` instances
#[allow(unused)]
pub(crate) fn run_fold<V: Fold>(
  code: &str,
  make_fold: impl FnOnce(RunTestContext) -> V,
) -> RunVisitResult<V> {
  let (output_code, visitor) = run_with_transformation(
    code,
    |run_test_context: RunTestContext, module: &mut Module| {
      let mut visit = make_fold(run_test_context);
      *module = module.take().fold_with(&mut visit);
      visit
    },
  );
  RunVisitResult {
    output_code,
    visitor,
  }
}

/// Parse code, run resolver over it, then run the `tranform` function with the parsed module
/// codegen and return the results.
fn run_with_transformation<R>(
  code: &str,
  transform: impl FnOnce(RunTestContext, &mut Module) -> R,
) -> (String, R) {
  let source_map = Lrc::new(SourceMap::default());
  let source_file = source_map.new_source_file(Lrc::new(FileName::Anon), code.into());

  let lexer = Lexer::new(
    Default::default(),
    Default::default(),
    StringInput::from(&*source_file),
    None,
  );

  let mut parser = Parser::new_from(lexer);
  let module = parser.parse_module().unwrap();

  GLOBALS.set(&Globals::new(), || {
    let global_mark = Mark::new();
    let unresolved_mark = Mark::new();
    let mut module = module.fold_with(&mut resolver(unresolved_mark, global_mark, false));

    let context = RunTestContext {
      source_map: source_map.clone(),
      global_mark,
      unresolved_mark,
    };
    let result = transform(context, &mut module);

    let mut output_buffer = vec![];
    let writer = JsWriter::new(source_map.clone(), "\n", &mut output_buffer, None);
    let mut emitter = swc_core::ecma::codegen::Emitter {
      cfg: Default::default(),
      cm: source_map,
      comments: None,
      wr: writer,
    };
    emitter.emit_module(&module).unwrap();
    let output_code = String::from_utf8(output_buffer).unwrap();

    (output_code, result)
  })
}

#[cfg(test)]
mod test {
  use swc_core::ecma::{
    ast::{Lit, Str},
    visit::VisitMut,
  };

  use super::*;

  #[test]
  fn test_example() {
    struct Visitor;
    impl VisitMut for Visitor {
      fn visit_mut_lit(&mut self, n: &mut Lit) {
        *n = Lit::Str(Str::from("replacement"));
      }
    }

    let code = r#"console.log('test!')"#;
    let RunVisitResult { output_code, .. } = run_visit(code, |_: RunTestContext| Visitor);
    assert_eq!(
      output_code,
      r#"console.log("replacement");
"#
    );
  }

  #[test]
  fn test_fold() {
    struct Folder;
    impl Fold for Folder {
      fn fold_lit(&mut self, _n: Lit) -> Lit {
        Lit::Str(Str::from("replacement"))
      }
    }

    let code = r#"console.log('test!')"#;
    let RunVisitResult { output_code, .. } = run_fold(code, |_: RunTestContext| Folder);
    assert_eq!(
      output_code,
      r#"console.log("replacement");
"#
    );
  }
}
