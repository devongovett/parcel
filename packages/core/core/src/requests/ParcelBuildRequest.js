// @flow strict-local

import type {ContentKey} from '@parcel/graph';
import type {Async} from '@parcel/types';
import type {SharedReference} from '@parcel/workers';

import type {StaticRunOpts} from '../RequestTracker';
import type {Asset, AssetGroup, PackagedBundleInfo} from '../types';
import type BundleGraph from '../BundleGraph';

import createBundleGraphRequest, {
  type BundleGraphResult,
} from './BundleGraphRequest';
import createWriteBundlesRequest from './WriteBundlesRequest';
import {assertSignalNotAborted} from '../utils';
import dumpGraphToGraphViz from '../dumpGraphToGraphViz';
import {bundleGraphEdgeTypes} from '../BundleGraph';
import {report} from '../ReporterRunner';
import IBundleGraph from '../public/BundleGraph';
import {NamedBundle} from '../public/Bundle';
import {assetFromValue} from '../public/Asset';

import {tracer} from '@parcel/profiler';
import {requestTypes} from '../RequestTracker';

type ParcelBuildRequestInput = {|
  optionsRef: SharedReference,
  requestedAssetIds: Set<string>,
  signal?: AbortSignal,
|};

export type ParcelBuildRequestResult = {|
  bundleGraph: BundleGraph,
  bundleInfo: Map<string, PackagedBundleInfo[]>,
  changedAssets: Map<string, Asset>,
  assetRequests: Array<AssetGroup>,
|};

type RunInput<TResult> = {|
  input: ParcelBuildRequestInput,
  ...StaticRunOpts<TResult>,
|};

export type ParcelBuildRequest = {|
  id: ContentKey,
  +type: typeof requestTypes.parcel_build_request,
  run: (RunInput<ParcelBuildRequestResult>) => Async<ParcelBuildRequestResult>,
  input: ParcelBuildRequestInput,
|};

export default function createParcelBuildRequest(
  input: ParcelBuildRequestInput,
): ParcelBuildRequest {
  return {
    type: requestTypes.parcel_build_request,
    id: 'parcel_build_request',
    run,
    input,
  };
}

async function run({input, api, options}) {
  let {optionsRef, requestedAssetIds, signal} = input;

  let bundleGraphRequest = createBundleGraphRequest({
    optionsRef,
    requestedAssetIds,
    signal,
  });

  let {bundleGraph, changedAssets, assetRequests}: BundleGraphResult =
    await api.runRequest(bundleGraphRequest, {
      force: options.shouldBuildLazily && requestedAssetIds.size > 0,
    });

  // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381 (Windows only)
  dumpGraphToGraphViz(bundleGraph._graph, 'BundleGraph', bundleGraphEdgeTypes);

  await report({
    type: 'buildProgress',
    phase: 'bundled',
    bundleGraph: new IBundleGraph(
      bundleGraph,
      (bundle, bundleGraph, options) =>
        NamedBundle.get(bundle, bundleGraph, options),
      options,
    ),
    changedAssets: new Map(
      Array.from(changedAssets).map(([id, asset]) => [
        id,
        assetFromValue(asset, options),
      ]),
    ),
  });

  let packagingMeasurement = tracer.createMeasurement('packaging');
  let writeBundlesRequest = createWriteBundlesRequest({
    bundleGraph,
    optionsRef,
  });

  let bundleInfo = await api.runRequest(writeBundlesRequest);
  packagingMeasurement && packagingMeasurement.end();
  assertSignalNotAborted(signal);

  return {bundleGraph, bundleInfo, changedAssets, assetRequests};
}
