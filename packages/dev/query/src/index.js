// @flow strict-local
/* eslint-disable no-console, monorepo/no-internal-import */
import type {ContentKey, NodeId} from '@parcel/graph';
import type {PackagedBundleInfo} from '@parcel/core/src/types';

import fs from 'fs';
import path from 'path';
import v8 from 'v8';
import nullthrows from 'nullthrows';
import invariant from 'assert';

const {
  AssetGraph,
  BundleGraph: {default: BundleGraph},
  RequestTracker: {
    default: RequestTracker,
    RequestGraph,
    requestGraphEdgeTypes,
  },
  LMDBCache,
} = require('./deep-imports.js');

export async function loadGraphs(cacheDir: string): Promise<{|
  assetGraph: ?AssetGraph,
  bundleGraph: ?BundleGraph,
  requestTracker: ?RequestTracker,
  bundleInfo: ?Map<ContentKey, PackagedBundleInfo>,
  cacheInfo: ?Map<string, Array<string | number>>,
|}> {
  function getMostRecentCacheBlobs() {
    let files = fs.readdirSync(cacheDir);

    let result = {};

    let blobsToFind: Array<{|
      name: string,
      check: (v: string) => boolean,
      mtime?: Date,
    |}> = [
      {
        name: 'requestGraphBlob',
        check: basename => basename.endsWith('RequestGraph'),
      },
      {
        name: 'bundleGraphBlob',
        check: basename => basename.endsWith('BundleGraph'),
      },
      {
        name: 'assetGraphBlob',
        check: basename => basename.endsWith('AssetGraph'),
      },
    ];

    for (let file of files) {
      let basename = path.basename(file);
      let match = blobsToFind.find(({check}) => check(basename));

      if (match) {
        let stat = fs.statSync(path.join(cacheDir, file));

        if (!match.mtime || stat.mtime > match.mtime) {
          match.mtime = stat.mtime;
          result[match.name] = file;
        }
      }
    }

    return result;
  }

  let cacheInfo: Map<string, Array<string | number>> = new Map();

  let {requestGraphBlob, bundleGraphBlob, assetGraphBlob} =
    getMostRecentCacheBlobs();
  const cache = new LMDBCache(cacheDir);

  // Get requestTracker
  let requestTracker;
  if (requestGraphBlob) {
    try {
      let file = await cache.getLargeBlob(path.basename(requestGraphBlob));
      let timeToDeserialize = Date.now();
      let obj = v8.deserialize(file);
      timeToDeserialize = Date.now() - timeToDeserialize;

      requestTracker = new RequestTracker({
        graph: RequestGraph.deserialize(obj.value),
        // $FlowFixMe
        farm: null,
        // $FlowFixMe
        options: null,
      });
      cacheInfo.set('RequestGraph', [Buffer.byteLength(file)]);
      cacheInfo.get('RequestGraph')?.push(timeToDeserialize);
    } catch (e) {
      console.log('Error loading Request Graph\n', e);
    }
  }

  // Get bundleGraph
  let bundleGraph;
  if (bundleGraphBlob) {
    try {
      let file = await cache.getLargeBlob(path.basename(bundleGraphBlob));

      let timeToDeserialize = Date.now();
      let obj = v8.deserialize(file);
      invariant(obj.bundleGraph != null);
      bundleGraph = BundleGraph.deserialize(obj.bundleGraph.value);
      timeToDeserialize = Date.now() - timeToDeserialize;

      cacheInfo.set('BundleGraph', [Buffer.byteLength(file)]);
      cacheInfo.get('BundleGraph')?.push(timeToDeserialize);
    } catch (e) {
      console.log('Error loading Bundle Graph\n', e);
    }
  }

  // Get assetGraph
  let assetGraph;
  if (assetGraphBlob) {
    try {
      let file = await cache.getLargeBlob(path.basename(assetGraphBlob));

      let timeToDeserialize = Date.now();
      let obj = v8.deserialize(file);
      invariant(obj.assetGraph != null);
      assetGraph = AssetGraph.deserialize(obj.assetGraph.value);
      timeToDeserialize = Date.now() - timeToDeserialize;

      cacheInfo.set('AssetGraph', [Buffer.byteLength(file)]);
      cacheInfo.get('AssetGraph')?.push(timeToDeserialize);
    } catch (e) {
      console.log('Error loading Asset Graph\n', e);
    }
  }

  function getSubRequests(id: NodeId) {
    return requestTracker.graph
      .getNodeIdsConnectedFrom(id, requestGraphEdgeTypes.subrequest)
      .map(n => nullthrows(requestTracker.graph.getNode(n)));
  }

  // Load graphs by finding the main subrequests and loading their results
  let bundleInfo;
  try {
    invariant(requestTracker);
    let buildRequestId = requestTracker.graph.getNodeIdByContentKey(
      'parcel_build_request',
    );
    let buildRequestNode = nullthrows(
      requestTracker.graph.getNode(buildRequestId),
    );
    invariant(
      buildRequestNode.type === 1 && buildRequestNode.requestType === 1,
    );
    let buildRequestSubRequests = getSubRequests(buildRequestId);

    let writeBundlesRequest = buildRequestSubRequests.find(
      n => n.type === 1 && n.requestType === 11,
    );
    if (writeBundlesRequest != null) {
      invariant(writeBundlesRequest.type === 1);
      // $FlowFixMe[incompatible-cast]
      bundleInfo = (nullthrows(writeBundlesRequest.result): Map<
        ContentKey,
        PackagedBundleInfo,
      >);
    }
  } catch (e) {
    console.log('Error loading bundleInfo\n', e);
  }

  return {assetGraph, bundleGraph, requestTracker, bundleInfo, cacheInfo};
}
