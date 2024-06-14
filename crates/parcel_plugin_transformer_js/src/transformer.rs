use std::path::PathBuf;
use std::rc::Rc;

use anyhow::{anyhow, Error};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use parcel_core::plugin::TransformerPlugin;
use parcel_core::plugin::{RunTransformContext, TransformResult, TransformationInput};
use parcel_core::types::engines::EnvironmentFeature;
use parcel_core::types::{
  Asset, BundleBehavior, Dependency, Environment, EnvironmentContext, FileType, ImportAttribute,
  JSONObject, Location, OutputFormat, ParcelOptions, Priority, SourceCode, SourceLocation,
  SourceType, SpecifierType, Symbol, SymbolFlags,
};
use parcel_js_swc_core::{
  Config, DependencyDescriptor, DependencyKind, ExportedSymbol, ImportedSymbol,
};
use parcel_resolver::{ExportsCondition, IncludeNodeModules};

/// This is a rust only `TransformerPlugin` implementation for JS assets that goes through the
/// default SWC transformer.
#[derive(Debug)]
pub struct ParcelJsTransformerPlugin {}

impl ParcelJsTransformerPlugin {
  pub fn new() -> Self {
    Self {}
  }
}

impl TransformerPlugin for ParcelJsTransformerPlugin {
  fn transform(
    &mut self,
    context: &mut RunTransformContext,
    input: TransformationInput,
  ) -> Result<TransformResult, Error> {
    let file_system = context.file_system();
    let source_code = input.read_source_code(file_system)?;

    let transformation_result = parcel_js_swc_core::transform(
      Config {
        filename: input
          .file_path()
          .to_str()
          .ok_or_else(|| anyhow!("Invalid non UTF-8 file-path"))?
          .to_string(),
        code: source_code.bytes().to_vec(),
        source_type: parcel_js_swc_core::SourceType::Module,
        ..Config::default()
      },
      None,
    )?;

    // TODO handle errors properly
    if let Some(errors) = transformation_result.diagnostics {
      return Err(anyhow!(format!("{:#?}", errors)));
    }

    let asset = Asset::new_empty(input.file_path().to_path_buf(), source_code);
    let config = Config::default();
    let options = ParcelOptions::default();
    let result = convert_result(asset, &config, transformation_result, &options)
      // TODO handle errors properly
      .map_err(|_err| anyhow!("Failed to transform"))?;

    Ok(result)
  }
}

#[derive(Debug, Serialize, Deserialize)]
struct Diagnostic {
  origin: String,
  message: String,
}

fn convert_result(
  mut asset: Asset,
  transformer_config: &Config,
  result: parcel_js_swc_core::TransformResult,
  options: &ParcelOptions,
) -> Result<TransformResult, Vec<Diagnostic>> {
  let asset_file_path = asset.file_path().to_path_buf();
  let asset_environment = asset.env.clone();
  let asset_id = asset.id();

  if let Some(shebang) = result.shebang {
    asset.meta.insert("interpreter".into(), shebang.into());
  }

  let mut dependency_by_specifier = IndexMap::new();
  // let mut dep_flags = DependencyFlags::empty();
  // dep_flags.set(
  //   DependencyFlags::HAS_SYMBOLS,
  //   result.hoist_result.is_some() || result.symbol_result.is_some(),
  // );

  let mut invalidate_on_file_change = Vec::new();

  for transformer_dependency in result.dependencies {
    let loc = convert_loc(asset_file_path.clone(), &transformer_dependency.loc);
    let placeholder = transformer_dependency
      .placeholder
      .as_ref()
      .map(|d| d.as_str().into())
      .unwrap_or_else(|| transformer_dependency.specifier.clone());

    let result = convert_dependency(
      transformer_config,
      &asset_file_path,
      &asset_environment,
      asset_id,
      transformer_dependency,
      loc,
    )?;
    match result {
      DependencyConversionResult::Dependency(dependency) => {
        dependency_by_specifier.insert(placeholder, dependency);
      }
      DependencyConversionResult::InvalidateOnFileChange(file_path) => {
        invalidate_on_file_change.push(file_path);
      }
    }
  }

  if result.needs_esm_helpers {
    let d = make_esm_helpers_dependency(options, &asset_file_path, asset_environment, asset_id);
    dependency_by_specifier.insert(d.specifier.as_str().into(), d);
  }

  let mut _has_cjs_exports = false;
  let mut _static_cjs_exports = false;
  let mut _should_wrap = false;
  let symbols = &mut asset.symbols;
  if let Some(hoist_result) = result.hoist_result {
    // asset.flags |= AssetFlags::HAS_SYMBOLS;
    symbols.reserve(hoist_result.exported_symbols.len() + hoist_result.re_exports.len() + 1);

    for symbol in &hoist_result.exported_symbols {
      let symbol = transformer_exported_symbol_into_symbol(&asset_file_path, &symbol);
      symbols.push(symbol);
    }

    for symbol in hoist_result.imported_symbols {
      if let Some(dependency) = dependency_by_specifier.get_mut(&symbol.source) {
        let symbol = transformer_imported_symbol_to_symbol(&asset_file_path, &symbol);
        dependency.symbols.push(symbol);
      }
    }

    for symbol in hoist_result.re_exports {
      if let Some(dependency) = dependency_by_specifier.get_mut(&symbol.source) {
        if &*symbol.local == "*" && &*symbol.imported == "*" {
          let loc = Some(convert_loc(asset_file_path.clone(), &symbol.loc));
          dependency.symbols.push(make_export_all_symbol(loc));
        } else {
          let existing = dependency
            .symbols
            .as_slice()
            .iter()
            .find(|candidate| candidate.exported == &*symbol.imported);
          let existing_flags = existing.map(|e| e.flags).unwrap_or(SymbolFlags::IS_WEAK);
          let re_export_name = existing
            .map(|sym| sym.local.clone())
            .unwrap_or_else(|| format!("${:016x}$re_export${}", asset_id, symbol.local).into());
          dependency.symbols.push(Symbol {
            exported: symbol.imported.as_ref().into(),
            local: re_export_name.clone(),
            loc: Some(convert_loc(asset_file_path.clone(), &symbol.loc)),
            flags: existing_flags & SymbolFlags::IS_WEAK,
          });
          symbols.push(Symbol {
            exported: symbol.local.as_ref().into(),
            local: re_export_name,
            loc: Some(convert_loc(asset_file_path.clone(), &symbol.loc)),
            flags: existing_flags & SymbolFlags::IS_WEAK,
          });
        }
      }
    }

    // for specifier in hoist_result.wrapped_requires {
    //   if let Some(dep) = dep_map.get_mut(&specifier) {
    //     dep.flags |= DependencyFlags::SHOULD_WRAP;
    //   }
    // }

    // for (name, specifier) in hoist_result.dynamic_imports {
    //   if let Some(dep) = dep_map.get_mut(&specifier) {
    //     dep.promise_symbol = Some((&*name).into());
    //   }
    // }

    if !hoist_result.self_references.is_empty() {
      for name in hoist_result.self_references {
        // Do not create a self-reference for the `default` symbol unless we have seen an __esModule flag.
        if &*name == "default"
          && !symbols
            .as_slice()
            .iter()
            .any(|s| &*s.exported == "__esModule")
        {
          continue;
        }

        let symbol = symbols
          .iter_mut()
          .find(|s| s.exported.as_str() == name.as_str())
          .unwrap();

        symbol.flags |= SymbolFlags::SELF_REFERENCED;
      }
    }

    // Add * symbol if there are CJS exports, no imports/exports at all
    // (and the asset has side effects), or the asset is wrapped.
    // This allows accessing symbols that don't exist without errors in symbol propagation.
    if (hoist_result.has_cjs_exports
      || (!hoist_result.is_esm
        && asset.side_effects
        && dependency_by_specifier.is_empty()
        && hoist_result.exported_symbols.is_empty())
      || hoist_result.should_wrap)
      && !symbols.as_slice().iter().any(|s| s.exported == "*")
    {
      symbols.push(make_export_star_symbol(asset_id));
    }

    _has_cjs_exports = hoist_result.has_cjs_exports;
    _static_cjs_exports = hoist_result.static_cjs_exports;
    _should_wrap = hoist_result.should_wrap;
  } else {
    if let Some(symbol_result) = result.symbol_result {
      // asset.flags |= AssetFlags::HAS_SYMBOLS;
      symbols.reserve(symbol_result.exports.len() + 1);
      for sym in &symbol_result.exports {
        let (local, flags) = if let Some(dep) = sym
          .source
          .as_ref()
          .and_then(|source| dependency_by_specifier.get_mut(source))
        {
          let local = format!("${:016x}${}", dep.id(), sym.local);
          dep.symbols.push(Symbol {
            exported: sym.local.as_ref().into(),
            local: local.clone(),
            loc: Some(convert_loc(asset_file_path.clone(), &sym.loc)),
            flags: SymbolFlags::IS_WEAK,
          });
          (local, SymbolFlags::IS_WEAK)
        } else {
          (format!("${}", sym.local).into(), SymbolFlags::empty())
        };

        symbols.push(Symbol {
          exported: sym.exported.as_ref().into(),
          local,
          loc: Some(convert_loc(asset_file_path.clone(), &sym.loc)),
          flags,
        });
      }

      for sym in symbol_result.imports {
        if let Some(dep) = dependency_by_specifier.get_mut(&sym.source) {
          dep.symbols.push(Symbol {
            exported: sym.imported.as_ref().into(),
            local: sym.local.as_ref().into(),
            loc: Some(convert_loc(asset_file_path.clone(), &sym.loc)),
            flags: SymbolFlags::empty(),
          });
        }
      }

      for sym in symbol_result.exports_all {
        if let Some(dep) = dependency_by_specifier.get_mut(&sym.source) {
          let loc = Some(convert_loc(asset_file_path.clone(), &sym.loc));
          dep.symbols.push(make_export_all_symbol(loc));
        }
      }

      // Add * symbol if there are CJS exports, no imports/exports at all, or the asset is wrapped.
      // This allows accessing symbols that don't exist without errors in symbol propagation.
      if symbol_result.has_cjs_exports
        || (!symbol_result.is_esm
          && asset.side_effects
          && dependency_by_specifier.is_empty()
          && symbol_result.exports.is_empty())
        || (symbol_result.should_wrap && !symbols.as_slice().iter().any(|s| s.exported == "*"))
      {
        symbols.push(make_export_star_symbol(asset_id));
      }
    } else {
      // If the asset is wrapped, add * as a fallback
      symbols.push(make_export_star_symbol(asset_id));
    }

    // For all other imports and requires, mark everything as imported (this covers both dynamic
    // imports and non-top-level requires.)
    for dep in dependency_by_specifier.values_mut() {
      if dep.symbols.is_empty() {
        dep.symbols.push(Symbol {
          exported: "*".into(),
          local: "".into(), // format!("${}$", dep.placeholder.as_ref().unwrap_or(&dep.specifier)).into(),
          flags: SymbolFlags::empty(),
          loc: None,
        });
      }
    }
  }

  // asset.flags.set(
  //   AssetFlags::HAS_NODE_REPLACEMENTS,
  //   result.has_node_replacements,
  // );
  // asset
  //     .flags
  //     .set(AssetFlags::IS_CONSTANT_MODULE, result.is_constant_module);
  // asset
  //     .flags
  //     .set(AssetFlags::HAS_CJS_EXPORTS, has_cjs_exports);
  // asset
  //     .flags
  //     .set(AssetFlags::STATIC_EXPORTS, static_cjs_exports);
  // asset.flags.set(AssetFlags::SHOULD_WRAP, should_wrap);

  // if asset.unique_key.is_none() {
  //   asset.unique_key = Some(format!("{:016x}", asset_id));
  // }
  asset.asset_type = FileType::Js;

  // Overwrite the source-code with SWC output
  let result_source_code_string = String::from_utf8(result.code)
    // TODO: This is impossible; but we should extend 'diagnostic' type to be nicer / easier to build
    .map_err(|_| vec![])?;
  asset.source_code = Rc::new(SourceCode::from(result_source_code_string));

  Ok(TransformResult {
    asset,
    dependencies: dependency_by_specifier.into_values().collect(),
    // map: result.map,
    // shebang: result.shebang,
    // dependencies: deps,
    // diagnostics: result.diagnostics,
    // used_env: result.used_env.into_iter().map(|v| v.to_string()).collect(),
    invalidate_on_file_change,
  })
}

fn make_export_star_symbol(asset_id: u64) -> Symbol {
  Symbol {
    exported: "*".into(),
    // This is the mangled exports name
    local: format!("${:016x}$exports", asset_id).into(),
    loc: None,
    flags: SymbolFlags::empty(),
  }
}

fn transformer_imported_symbol_to_symbol(
  asset_file_path: &PathBuf,
  sym: &ImportedSymbol,
) -> Symbol {
  Symbol {
    exported: sym.imported.as_ref().into(),
    local: sym.local.as_ref().into(),
    loc: Some(convert_loc(asset_file_path.clone(), &sym.loc)),
    flags: SymbolFlags::empty(),
  }
}

fn transformer_exported_symbol_into_symbol(
  asset_file_path: &PathBuf,
  symbol: &ExportedSymbol,
) -> Symbol {
  let mut flags = SymbolFlags::empty();
  flags.set(SymbolFlags::IS_ESM, symbol.is_esm);
  Symbol {
    exported: symbol.exported.as_ref().into(),
    local: symbol.local.as_ref().into(),
    loc: Some(convert_loc(asset_file_path.clone(), &symbol.loc)),
    flags,
  }
}

fn make_esm_helpers_dependency(
  options: &ParcelOptions,
  asset_file_path: &PathBuf,
  asset_environment: Environment,
  asset_id: u64,
) -> Dependency {
  Dependency {
    source_asset_id: Some(format!("{:016x}", asset_id)),
    specifier: "@parcel/transformer-js/src/esmodule-helpers.js".into(),
    specifier_type: SpecifierType::Esm,
    source_path: Some(asset_file_path.clone()),
    env: Environment {
      include_node_modules: IncludeNodeModules::Map(
        [("@parcel/transformer-js".to_string(), true)]
          .into_iter()
          .collect(),
      ),
      ..asset_environment.clone()
    }
    .into(),
    resolve_from: Some(options.core_path.as_path().into()),
    range: None,
    priority: Priority::Sync,
    bundle_behavior: BundleBehavior::None,
    // flags: dep_flags,
    loc: None,
    // placeholder: None,
    target: None,
    // promise_symbol: None,
    symbols: Vec::new(),
    // import_attributes: Vec::new(),
    pipeline: None,
    meta: JSONObject::new(),
    // resolver_meta: JSONObject::new(),
    package_conditions: ExportsCondition::empty(),
    // custom_package_conditions: Vec::new(),
    // TODO:
    is_entry: false,
    needs_stable_name: false,
    is_optional: false,
  }
}

fn make_export_all_symbol(loc: Option<SourceLocation>) -> Symbol {
  Symbol {
    exported: "*".into(),
    local: "*".into(),
    loc,
    flags: SymbolFlags::IS_WEAK,
  }
}

enum DependencyConversionResult {
  Dependency(Dependency),
  InvalidateOnFileChange(PathBuf),
}

fn convert_dependency(
  transformer_config: &Config,
  asset_file_path: &PathBuf,
  asset_environment: &Environment,
  asset_id: u64,
  transformer_dependency: DependencyDescriptor,
  loc: SourceLocation,
) -> Result<DependencyConversionResult, Vec<Diagnostic>> {
  let base_dependency = Dependency {
    source_asset_id: Some(format!("{:016x}", asset_id)),
    specifier: transformer_dependency.specifier.as_ref().into(),
    specifier_type: SpecifierType::Url,
    source_path: Some(asset_file_path.clone()),
    resolve_from: None,
    range: None,
    priority: Priority::Lazy,
    bundle_behavior: BundleBehavior::None,
    loc: Some(loc.clone()),
    target: None,
    symbols: Vec::new(),
    pipeline: None,
    meta: JSONObject::new(),
    package_conditions: ExportsCondition::empty(),
    ..Dependency::default()
  };
  let source_type = if matches!(
    transformer_dependency.source_type,
    Some(parcel_js_swc_core::SourceType::Module)
  ) {
    SourceType::Module
  } else {
    SourceType::Script
  };
  match transformer_dependency.kind {
    DependencyKind::WebWorker => {
      // Use native ES module output if the worker was created with `type: 'module'` and all targets
      // support native module workers. Only do this if parent asset output format is also esmodule so that
      // assets can be shared between workers and the main thread in the global output format.
      let mut output_format = asset_environment.output_format;
      if output_format == OutputFormat::EsModule
        && matches!(
          transformer_dependency.source_type,
          Some(parcel_js_swc_core::SourceType::Module)
        )
        && transformer_config.supports_module_workers
      {
        output_format = OutputFormat::EsModule;
      } else if output_format != OutputFormat::Commonjs {
        output_format = OutputFormat::Global;
      }

      let dependency = Dependency {
        env: Environment {
          context: EnvironmentContext::WebWorker,
          source_type,
          output_format,
          loc: Some(loc.clone()),
          ..asset_environment.clone()
        }
        .into(),
        ..base_dependency
      };

      Ok(DependencyConversionResult::Dependency(dependency))
    }
    DependencyKind::ServiceWorker => {
      let dependency = Dependency {
        env: Environment {
          context: EnvironmentContext::ServiceWorker,
          source_type,
          output_format: OutputFormat::Global,
          loc: Some(loc.clone()),
          ..asset_environment.clone()
        }
        .into(),
        // flags: dep_flags | DependencyFlags::NEEDS_STABLE_NAME,
        // placeholder: dep.placeholder.map(|s| s.into()),
        // promise_symbol: None,
        // import_attributes: Vec::new(),
        // resolver_meta: JSONObject::new(),
        // custom_package_conditions: Vec::new(),
        ..base_dependency
      };

      Ok(DependencyConversionResult::Dependency(dependency))
    }
    DependencyKind::Worklet => {
      let dependency = Dependency {
        env: Environment {
          context: EnvironmentContext::Worklet,
          source_type: SourceType::Module,
          output_format: OutputFormat::EsModule,
          loc: Some(loc.clone()),
          ..asset_environment.clone()
        }
        .into(),
        // flags: dep_flags,
        // placeholder: dep.placeholder.map(|s| s.into()),
        // promise_symbol: None,
        // import_attributes: Vec::new(),
        // resolver_meta: JSONObject::new(),
        // custom_package_conditions: Vec::new(),
        ..base_dependency
      };

      Ok(DependencyConversionResult::Dependency(dependency))
    }
    DependencyKind::Url => {
      let dependency = Dependency {
        env: asset_environment.clone(),
        bundle_behavior: BundleBehavior::Isolated,
        // flags: dep_flags,
        // placeholder: dep.placeholder.map(|s| s.into()),
        // promise_symbol: None,
        // import_attributes: Vec::new(),
        // resolver_meta: JSONObject::new(),
        // custom_package_conditions: Vec::new(),
        ..base_dependency
      };

      Ok(DependencyConversionResult::Dependency(dependency))
    }
    DependencyKind::File => Ok(DependencyConversionResult::InvalidateOnFileChange(
      PathBuf::from(transformer_dependency.specifier.to_string()),
    )),
    _ => {
      // let mut flags = dep_flags;
      // flags.set(DependencyFlags::OPTIONAL, dep.is_optional);
      // flags.set(
      //   DependencyFlags::IS_ESM,
      //   matches!(dep.kind, DependencyKind::Import | DependencyKind::Export),
      // );

      let mut env = asset_environment.clone();
      if transformer_dependency.kind == DependencyKind::DynamicImport {
        // https://html.spec.whatwg.org/multipage/webappapis.html#hostimportmoduledynamically(referencingscriptormodule,-modulerequest,-promisecapability)
        if matches!(
          env.context,
          EnvironmentContext::Worklet | EnvironmentContext::ServiceWorker
        ) {
          let diagnostic = Diagnostic {
            origin: "@parcel/transformer-js".into(),
            message: format!(
              "import() is not allowed in {}.",
              match env.context {
                EnvironmentContext::Worklet => "worklets",
                EnvironmentContext::ServiceWorker => "service workers",
                _ => unreachable!(),
              }
            ),
          };
          // environment_diagnostic(&mut diagnostic, &asset, false);
          return Err(vec![diagnostic]);
        }

        // If all the target engines support dynamic import natively,
        // we can output native ESM if scope hoisting is enabled.
        // Only do this for scripts, rather than modules in the global
        // output format so that assets can be shared between the bundles.
        let mut output_format = env.output_format;
        if env.source_type == SourceType::Script
            // && env.flags.contains(EnvironmentFlags::SHOULD_SCOPE_HOIST)
            && env.engines.supports(EnvironmentFeature::DynamicImport)
        {
          output_format = OutputFormat::EsModule;
        }

        if env.source_type != SourceType::Module || env.output_format != output_format {
          env = Environment {
            source_type: SourceType::Module,
            output_format,
            loc: Some(loc.clone()),
            ..env.clone()
          }
          .into();
        }
      }

      let mut import_attributes = Vec::new();
      if let Some(attrs) = transformer_dependency.attributes {
        for (key, value) in attrs {
          import_attributes.push(ImportAttribute {
            key: String::from(&*key),
            value,
          });
        }
      }

      let dependency = Dependency {
        specifier_type: match transformer_dependency.kind {
          DependencyKind::Require => SpecifierType::CommonJS,
          _ => SpecifierType::Esm,
        },
        env,
        priority: match transformer_dependency.kind {
          DependencyKind::DynamicImport => Priority::Lazy,
          _ => Priority::Sync,
        },
        // flags,
        // placeholder: dep.placeholder.map(|s| s.into()),
        // promise_symbol: None,
        // import_attributes,
        // resolver_meta: JSONObject::new(),
        // custom_package_conditions: Vec::new(),
        ..base_dependency
      };

      Ok(DependencyConversionResult::Dependency(dependency))
    }
  }
}

fn convert_loc(file_path: PathBuf, loc: &parcel_js_swc_core::SourceLocation) -> SourceLocation {
  SourceLocation {
    file_path,
    start: Location {
      line: loc.start_line as u32,
      column: loc.start_col as u32,
    },
    end: Location {
      line: loc.end_line as u32,
      column: loc.end_col as u32,
    },
  }
}

#[cfg(test)]
mod test {
  use std::path::PathBuf;
  use std::rc::Rc;
  use std::sync::Arc;

  use parcel_core::plugin::{
    RunTransformContext, TransformResult, TransformationInput, TransformerPlugin,
  };
  use parcel_core::types::{
    Asset, Dependency, Environment, FileType, Location, SourceCode, SourceLocation, SpecifierType,
    Symbol, SymbolFlags,
  };
  use parcel_filesystem::in_memory_file_system::InMemoryFileSystem;

  use crate::ParcelJsTransformerPlugin;

  fn empty_asset() -> Asset {
    Asset {
      asset_type: FileType::Js,
      bundle_behavior: Default::default(),
      env: Default::default(),
      file_path: Default::default(),
      source_code: Rc::new(SourceCode::from(String::new())),
      is_bundle_splittable: false,
      is_source: false,
      meta: Default::default(),
      pipeline: None,
      query: None,
      side_effects: false,
      stats: Default::default(),
      symbols: vec![],
      unique_key: None,
    }
  }

  #[test]
  fn test_asset_id_is_stable() {
    let source_code = Rc::new(SourceCode::from(String::from("function hello() {}")));
    let asset_1 = Asset::new_empty("mock_path".into(), source_code.clone());
    let asset_2 = Asset::new_empty("mock_path".into(), source_code);
    // This nº should not change across runs/compilation
    assert_eq!(asset_1.id(), 4127533076662631483);
    assert_eq!(asset_1.id(), asset_2.id());
  }

  #[test]
  fn test_transformer_on_noop_asset() {
    let source_code = Rc::new(SourceCode::from(String::from("function hello() {}")));
    let target_asset = Asset::new_empty("mock_path".into(), source_code);
    let result = run_test(target_asset).unwrap();

    assert_eq!(
      result,
      TransformResult {
        asset: Asset {
          file_path: "mock_path".into(),
          asset_type: FileType::Js,
          // SWC inserts a newline here
          source_code: Rc::new(SourceCode::from(String::from("function hello() {}\n"))),
          symbols: vec![],
          ..empty_asset()
        },
        dependencies: vec![],
        invalidate_on_file_change: vec![]
      }
    );
  }

  #[test]
  fn test_transformer_on_asset_that_requires_other() {
    let source_code = Rc::new(SourceCode::from(String::from(
      r#"
const x = require('other');
exports.hello = function() {};
    "#,
    )));
    let target_asset = Asset::new_empty("mock_path.js".into(), source_code);
    let asset_id = target_asset.id();
    let result = run_test(target_asset).unwrap();

    let expected_dependencies = vec![Dependency {
      bundle_behavior: Default::default(),
      env: Environment::default(),
      is_entry: false,
      is_optional: false,
      loc: Some(SourceLocation {
        file_path: PathBuf::from("mock_path.js"),
        start: Location {
          line: 2,
          column: 19,
        },
        end: Location {
          line: 2,
          column: 26,
        },
      }),
      meta: Default::default(),
      needs_stable_name: false,
      package_conditions: Default::default(),
      pipeline: None,
      priority: Default::default(),
      range: None,
      resolve_from: None,
      source_asset_id: Some(format!("{:016x}", asset_id)),
      source_path: Some(PathBuf::from("mock_path.js")),
      specifier: String::from("other"),
      specifier_type: SpecifierType::CommonJS,
      symbols: vec![Symbol {
        exported: String::from("*"),
        loc: None,
        local: String::from(""),
        flags: SymbolFlags::empty(),
      }],
      target: None,
    }];
    assert_eq!(result.dependencies, expected_dependencies);
    assert_eq!(
      result,
      TransformResult {
        asset: Asset {
          file_path: "mock_path.js".into(),
          asset_type: FileType::Js,
          // SWC inserts a newline here
          source_code: Rc::new(SourceCode::from(String::from(
            "const x = require(\"e83f3db3d6f57ea6\");\nexports.hello = function() {};\n"
          ))),
          symbols: vec![
            Symbol {
              exported: String::from("hello"),
              loc: Some(SourceLocation {
                file_path: PathBuf::from("mock_path.js"),
                start: Location { line: 3, column: 9 },
                end: Location {
                  line: 3,
                  column: 14
                }
              }),
              local: String::from("$hello"),
              flags: SymbolFlags::empty(),
            },
            Symbol {
              exported: String::from("*"),
              loc: Some(SourceLocation {
                file_path: PathBuf::from("mock_path.js"),
                start: Location { line: 1, column: 1 },
                end: Location { line: 1, column: 1 }
              }),
              local: String::from("$_"),
              flags: SymbolFlags::empty(),
            },
            Symbol {
              exported: String::from("*"),
              loc: None,
              local: format!("${:016x}$exports", asset_id),
              flags: SymbolFlags::empty(),
            }
          ],
          ..empty_asset()
        },
        dependencies: expected_dependencies,
        invalidate_on_file_change: vec![]
      }
    );
  }

  fn run_test(asset: Asset) -> anyhow::Result<TransformResult> {
    let file_system = Arc::new(InMemoryFileSystem::default());
    let mut context = RunTransformContext::new(file_system);
    let mut transformer = ParcelJsTransformerPlugin::new();
    let input = TransformationInput::Asset(asset);

    let result = transformer.transform(&mut context, input)?;
    Ok(result)
  }
}
