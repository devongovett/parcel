use arena::{SerializableHandle, Sink};
use dependencies::{collect_dependencies, Asset, Dependency, Error};
use html5ever::driver::ParseOpts;
use html5ever::serialize::SerializeOpts;
use html5ever::tendril::TendrilSink;
use html5ever::{parse_document, serialize};
use serde::{Deserialize, Serialize};
use typed_arena::Arena;

mod arena;
mod dependencies;
mod srcset;

#[derive(Deserialize)]
pub struct Options {
  #[serde(with = "serde_bytes")]
  pub code: Vec<u8>,
  pub scope_hoist: bool,
  pub supports_esm: bool,
  pub hmr: bool,
}

#[derive(Serialize)]
pub struct HTMLResult {
  dependencies: Vec<Dependency>,
  #[serde(with = "serde_bytes")]
  code: Vec<u8>,
  assets: Vec<Asset>,
  errors: Vec<Error>,
}

pub fn transform_html(options: Options) -> HTMLResult {
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
  let handle: SerializableHandle = dom.into();
  serialize(&mut vec, &handle, SerializeOpts::default());

  HTMLResult {
    code: vec,
    dependencies: deps,
    assets,
    errors,
  }
}
