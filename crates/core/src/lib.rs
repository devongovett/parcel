pub mod asset_graph;
pub mod cache;
pub mod environment;
mod intern;
pub mod parcel_config;
pub mod request_tracker;
pub mod requests;
pub mod transformers;
pub mod types;
pub mod worker_farm;

use asset_graph::{AssetGraph, AssetGraphRequest};
use cache::Cache;
use request_tracker::RequestTracker;
use types::ParcelOptions;
// use requests::bundle_graph_request::BundleGraphRequest;
use worker_farm::WorkerFarm;

use crate::requests::parcel_config_request::ParcelConfigRequest;

pub fn build(
  entries: Vec<String>,
  farm: WorkerFarm,
  cache: &Cache,
  options: ParcelOptions,
) -> AssetGraph {
  let mut request_tracker = RequestTracker::new(farm, options);
  let config = request_tracker.run_request(ParcelConfigRequest {}).unwrap();

  let mut req = AssetGraphRequest {
    entries,
    transformers: &config.transformers,
    resolvers: &config.resolvers,
  };
  let asset_graph = req.build(&mut request_tracker, cache);

  // let bundles = request_tracker
  //   .run_request(BundleGraphRequest {
  //     asset_graph,
  //     bundler: config.bundler.clone(),
  //   })
  //   .unwrap();

  // println!("BUNDLES: {:?}", bundles);
  asset_graph
}
