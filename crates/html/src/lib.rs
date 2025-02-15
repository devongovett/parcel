use std::collections::HashMap;

use arena::{SerializableHandle, Sink};
use dependencies::{collect_dependencies, Asset, Dependency, Error};
use html5ever::driver::ParseOpts;
use html5ever::parse_document;
use html5ever::tendril::{StrTendril, TendrilSink};
use optimize::optimize;
use package::{insert_bundle_references, BundleReference, InlineBundle};
use serde::{Deserialize, Serialize, Serializer};
use typed_arena::Arena;

mod arena;
mod dependencies;
mod optimize;
mod oxvg;
mod package;
mod serialize;
mod srcset;

#[derive(Hash, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct SerializableTendril(StrTendril);

impl serde::Serialize for SerializableTendril {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: Serializer,
  {
    serializer.serialize_str(self.0.as_ref())
  }
}

impl<'de> serde::Deserialize<'de> for SerializableTendril {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let s: String = Deserialize::deserialize(deserializer)?;
    Ok(SerializableTendril(s.into()))
  }
}

#[derive(Deserialize)]
pub struct TransformOptions {
  #[serde(with = "serde_bytes")]
  pub code: Vec<u8>,
  pub scope_hoist: bool,
  pub supports_esm: bool,
  pub hmr: bool,
}

#[derive(Serialize)]
pub struct TransformResult {
  dependencies: Vec<Dependency>,
  #[serde(with = "serde_bytes")]
  code: Vec<u8>,
  assets: Vec<Asset>,
  errors: Vec<Error>,
}

pub fn transform_html(options: TransformOptions) -> TransformResult {
  let arena = Arena::new();
  let dom = parse_document(Sink::new(&arena), ParseOpts::default())
    .from_utf8()
    .one(options.code.as_slice());
  let (deps, assets, errors) = collect_dependencies(
    &arena,
    &dom,
    options.scope_hoist,
    options.supports_esm,
    options.hmr,
  );

  let mut vec = Vec::new();
  html5ever::serialize::serialize(
    &mut vec,
    &SerializableHandle(dom),
    html5ever::serialize::SerializeOpts::default(),
  );

  TransformResult {
    code: vec,
    dependencies: deps,
    assets,
    errors,
  }
}

pub fn transform_svg(options: TransformOptions) -> TransformResult {
  let arena = Arena::new();
  let dom =
    xml5ever::driver::parse_document(Sink::new(&arena), xml5ever::driver::XmlParseOpts::default())
      .from_utf8()
      .one(options.code.as_slice());
  let (deps, assets, errors) = collect_dependencies(
    &arena,
    &dom,
    options.scope_hoist,
    options.supports_esm,
    options.hmr,
  );

  let mut vec = Vec::new();
  let handle: SerializableHandle = dom.into();
  xml5ever::serialize::serialize(
    &mut vec,
    &handle,
    xml5ever::serialize::SerializeOpts::default(),
  );

  TransformResult {
    code: vec,
    dependencies: deps,
    assets,
    errors,
  }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageOptions {
  #[serde(with = "serde_bytes")]
  pub code: Vec<u8>,
  pub bundles: Vec<BundleReference>,
  pub inline_bundles: HashMap<SerializableTendril, InlineBundle>,
  pub import_map: serde_json::Map<String, serde_json::Value>,
}

#[derive(Serialize)]
pub struct PackageResult {
  #[serde(with = "serde_bytes")]
  pub code: Vec<u8>,
}

pub fn package_html(options: PackageOptions) -> PackageResult {
  let arena = Arena::new();
  let dom = parse_document(Sink::new(&arena), ParseOpts::default())
    .from_utf8()
    .one(options.code.as_slice());

  insert_bundle_references(
    &arena,
    dom,
    options.bundles,
    options.inline_bundles,
    options.import_map,
  );

  let mut vec = Vec::new();
  html5ever::serialize::serialize(
    &mut vec,
    &SerializableHandle(dom),
    html5ever::serialize::SerializeOpts::default(),
  );

  PackageResult { code: vec }
}

pub fn package_svg(options: PackageOptions) -> PackageResult {
  let arena = Arena::new();
  let dom =
    xml5ever::driver::parse_document(Sink::new(&arena), xml5ever::driver::XmlParseOpts::default())
      .from_utf8()
      .one(options.code.as_slice());

  insert_bundle_references(
    &arena,
    dom,
    options.bundles,
    options.inline_bundles,
    options.import_map,
  );

  let mut vec = Vec::new();
  let handle: SerializableHandle = dom.into();
  xml5ever::serialize::serialize(
    &mut vec,
    &handle,
    xml5ever::serialize::SerializeOpts::default(),
  );

  PackageResult { code: vec }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeOptions {
  #[serde(with = "serde_bytes")]
  pub code: Vec<u8>,
}

pub fn optimize_html(options: OptimizeOptions) -> PackageResult {
  let arena = Arena::new();
  let dom = parse_document(Sink::new(&arena), ParseOpts::default())
    .from_utf8()
    .one(options.code.as_slice());

  optimize(&arena, dom);

  let mut vec = Vec::new();
  serialize::serialize(&mut vec, dom, serialize::SerializeOpts::default());

  PackageResult { code: vec }
}
