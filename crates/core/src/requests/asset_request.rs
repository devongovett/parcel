use std::path::PathBuf;

use crate::{
  diagnostic::Diagnostic,
  environment::Environment,
  intern::Interned,
  parcel_config::{PipelineMap, PluginNode},
  request_tracker::{Invalidation, Request, RequestResult},
  transformers::run_transformer,
  types::{Asset, AssetFlags, AssetStats, AssetType, Dependency, JSONObject, ParcelOptions},
  worker_farm::WorkerFarm,
};
use xxhash_rust::xxh3::xxh3_64;

#[derive(Hash, Debug)]
pub struct AssetRequest<'a> {
  pub transformers: &'a PipelineMap,
  pub file_path: Interned<PathBuf>,
  pub code: Option<Vec<u8>>,
  pub pipeline: Option<String>,
  pub env: Interned<Environment>,
  pub side_effects: bool,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct AssetRequestResult {
  pub asset: Asset,
  pub dependencies: Vec<Dependency>,
}

impl<'a> Request for AssetRequest<'a> {
  type Output = AssetRequestResult;

  fn run(self, farm: &WorkerFarm, options: &ParcelOptions) -> RequestResult<Self::Output> {
    // println!("transform {:?}", self.file_path);
    let pipeline = self.transformers.get::<&str>(
      &self.file_path,
      &self.pipeline.as_ref().map(|p| p.as_str()),
      false,
    );

    let mut flags = AssetFlags::IS_BUNDLE_SPLITTABLE;
    flags.set(
      AssetFlags::IS_SOURCE,
      !self
        .file_path
        .components()
        .any(|c| c.as_os_str() == "node_modules"),
    );
    flags.set(AssetFlags::SIDE_EFFECTS, self.side_effects);

    let asset = Asset {
      file_path: self.file_path,
      env: self.env,
      query: None,
      asset_type: AssetType::from_extension(
        self
          .file_path
          .extension()
          .and_then(|s| s.to_str())
          .unwrap_or(""),
      ),
      content_key: String::new(),
      map_key: None,
      output_hash: String::new(),
      pipeline: self.pipeline,
      meta: JSONObject::new(),
      stats: AssetStats { size: 0, time: 0 },
      bundle_behavior: crate::types::BundleBehavior::None,
      flags,
      symbols: Vec::new(),
      unique_key: None,
    };

    let code = self
      .code
      .unwrap_or_else(|| options.input_fs.read(&asset.file_path.as_ref()).unwrap());
    let result = run_pipeline(pipeline, asset, code, &self.transformers, farm, options);

    let result = match result {
      Ok(mut result) => {
        result.asset.output_hash = format!("{:x}", xxh3_64(&result.code));
        result.asset.content_key = format!("{:x}", result.asset.id()); // TODO
        result.asset.stats.size = result.code.len() as u32;

        options
          .cache
          .set(result.asset.content_key.clone(), result.code);
        Ok(AssetRequestResult {
          asset: result.asset,
          dependencies: result.dependencies,
        })
      }
      Err(err) => Err(err),
    };

    RequestResult {
      result,
      // TODO: add more invalidations
      invalidations: vec![Invalidation::InvalidateOnFileUpdate(self.file_path)],
    }
  }
}

#[derive(Clone, Debug, serde::Deserialize)]
pub struct TransformerResult {
  pub asset: Asset,
  #[serde(with = "serde_bytes")]
  pub code: Vec<u8>,
  pub dependencies: Vec<Dependency>,
}

pub trait Transformer {
  fn transform(
    &self,
    asset: Asset,
    code: Vec<u8>,
    farm: &WorkerFarm,
    options: &ParcelOptions,
  ) -> Result<TransformerResult, Vec<Diagnostic>>;
}

fn run_pipeline(
  pipeline: Vec<PluginNode>,
  asset: Asset,
  code: Vec<u8>,
  transformers: &PipelineMap,
  farm: &WorkerFarm,
  options: &ParcelOptions,
) -> Result<TransformerResult, Vec<Diagnostic>> {
  let mut result = TransformerResult {
    asset,
    code,
    dependencies: vec![],
  };

  for transformer in &pipeline {
    let asset_type = result.asset.asset_type;
    let transformed = run_transformer(transformer, result.asset, result.code, farm, options)?;
    if transformed.asset.asset_type != asset_type {
      let next_path = transformed
        .asset
        .file_path
        .with_extension(transformed.asset.asset_type.extension());
      let next_pipeline = transformers.get(&next_path, &transformed.asset.pipeline, false);
      if next_pipeline != pipeline {
        return run_pipeline(
          next_pipeline,
          transformed.asset,
          transformed.code,
          transformers,
          farm,
          options,
        );
      };
    }
    result.asset = transformed.asset;
    result.code = transformed.code;
    result.dependencies.extend(transformed.dependencies);
  }

  Ok(result)
}
