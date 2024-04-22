pub mod asset_graph;
pub mod parcel_config;
pub mod request_tracker;
pub mod requests;
pub mod transformers;
mod types;
pub mod worker_farm;

use asset_graph::AssetGraphRequest;
use request_tracker::RequestTracker;
use requests::bundle_graph_request::BundleGraphRequest;
use worker_farm::WorkerFarm;

use crate::requests::parcel_config_request::ParcelConfigRequest;

pub fn build(entries: Vec<String>, farm: WorkerFarm) {
  let mut req = AssetGraphRequest { entries };

  let mut request_tracker = RequestTracker::new(farm);
  let config = request_tracker.run_request(ParcelConfigRequest {}).unwrap();

  let asset_graph = req.build(&mut request_tracker);

  let bundles = request_tracker
    .run_request(BundleGraphRequest {
      asset_graph,
      bundler: config.bundler.clone(),
    })
    .unwrap();

  println!("BUNDLES: {:?}", bundles);
}