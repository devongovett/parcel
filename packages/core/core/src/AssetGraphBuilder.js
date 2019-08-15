// @flow strict-local

import type WorkerFarm from '@parcel/workers';
import type {ParcelOptions, Target} from './types';

import EventEmitter from 'events';
import {md5FromObject, md5FromString} from '@parcel/utils';
import watcher, {type Event} from '@parcel/watcher';

import type {Asset} from './types';
import AssetGraph from './AssetGraph';
import type ParcelConfig from './ParcelConfig';
import RequestGraph from './RequestGraph';
import type {
  AssetGraphNode,
  AssetRequest,
  AssetRequestNode,
  DepPathRequestNode
} from './types';

import dumpToGraphViz from './dumpGraphToGraphViz';
import path from 'path';

type Opts = {|
  options: ParcelOptions,
  config: ParcelConfig,
  entries?: Array<string>,
  targets?: Array<Target>,
  assetRequest?: AssetRequest,
  workerFarm: WorkerFarm
|};

export default class AssetGraphBuilder extends EventEmitter {
  assetGraph: AssetGraph;
  requestGraph: RequestGraph;
  controller: AbortController;
  changedAssets: Map<string, Asset> = new Map();
  options: ParcelOptions;
  cacheKey: string;

  async init({
    config,
    options,
    entries,
    targets,
    assetRequest,
    workerFarm
  }: Opts) {
    this.options = options;
    let {minify, hot, scopeHoist} = options;
    this.cacheKey = md5FromObject({
      options: {minify, hot, scopeHoist},
      entries,
      targets
    });

    let changes = await this.readFromCache();
    if (!changes) {
      this.assetGraph = new AssetGraph();
      this.requestGraph = new RequestGraph();
    }

    this.assetGraph.initOptions({
      onNodeAdded: node => this.handleNodeAddedToAssetGraph(node),
      onNodeRemoved: node => this.handleNodeRemovedFromAssetGraph(node)
    });

    this.requestGraph.initOptions({
      config,
      options,
      onAssetRequestComplete: this.handleCompletedAssetRequest.bind(this),
      onDepPathRequestComplete: this.handleCompletedDepPathRequest.bind(this),
      workerFarm
    });

    if (changes) {
      this.respondToFSEvents(changes);
    } else {
      this.assetGraph.initialize({
        entries,
        targets,
        assetGroup: assetRequest
      });
    }
  }

  async build(): Promise<{|
    assetGraph: AssetGraph,
    changedAssets: Map<string, Asset>
  |}> {
    await this.requestGraph.completeRequests();

    dumpToGraphViz(this.assetGraph, 'AssetGraph');
    dumpToGraphViz(this.requestGraph, 'RequestGraph');

    let changedAssets = this.changedAssets;
    this.changedAssets = new Map();

    return {assetGraph: this.assetGraph, changedAssets: changedAssets};
  }

  async validate(): Promise<void> {
    return this.requestGraph.completeValidations();
  }

  handleNodeAddedToAssetGraph(node: AssetGraphNode) {
    switch (node.type) {
      case 'dependency':
        this.requestGraph.addDepPathRequest(node.value);
        break;
      case 'asset_group':
        this.requestGraph.addAssetRequest(node.id, node.value);
        break;
      case 'asset': {
        let asset = node.value;
        this.changedAssets.set(asset.id, asset); // ? Is this right?
        break;
      }
    }
  }

  handleNodeRemovedFromAssetGraph(node: AssetGraphNode) {
    switch (node.type) {
      case 'dependency':
        this.requestGraph.removeById(node.id);
        break;
      case 'asset_group':
        this.requestGraph.removeById(node.id);
        break;
    }
  }

  handleCompletedAssetRequest(
    requestNode: AssetRequestNode,
    assets: Array<Asset>
  ) {
    this.assetGraph.resolveAssetGroup(requestNode.value, assets);
    for (let asset of assets) {
      this.changedAssets.set(asset.id, asset); // ? Is this right?
    }
  }

  handleCompletedDepPathRequest(
    requestNode: DepPathRequestNode,
    result: AssetRequest | null
  ) {
    this.assetGraph.resolveDependency(requestNode.value, result);
  }

  respondToFSEvents(events: Array<Event>) {
    return this.requestGraph.respondToFSEvents(events);
  }

  getWatcherOptions() {
    let targetDirs = this.options.targets.map(target => target.distDir);
    let vcsDirs = ['.git', '.hg'].map(dir =>
      path.join(this.options.projectRoot, dir)
    );
    let ignore = [this.options.cacheDir, ...targetDirs, ...vcsDirs];
    return {ignore};
  }

  getCacheKeys() {
    let assetGraphKey = md5FromString(`${this.cacheKey}:assetGraph`);
    let requestGraphKey = md5FromString(`${this.cacheKey}:requestGraph`);
    let snapshotKey = md5FromString(`${this.cacheKey}:snapshot`);
    return {assetGraphKey, requestGraphKey, snapshotKey};
  }

  async readFromCache(): Promise<?Array<Event>> {
    if (this.options.disableCache) {
      return null;
    }

    let {assetGraphKey, requestGraphKey, snapshotKey} = this.getCacheKeys();
    let assetGraph = await this.options.cache.get(assetGraphKey);
    let requestGraph = await this.options.cache.get(requestGraphKey);

    if (assetGraph && requestGraph) {
      this.assetGraph = assetGraph;
      this.requestGraph = requestGraph;

      let opts = this.getWatcherOptions();
      let snapshotPath = this.options.cache._getCachePath(snapshotKey, '.txt');
      return watcher.getEventsSince(
        this.options.projectRoot,
        snapshotPath,
        opts
      );
    }

    return null;
  }

  async writeToCache() {
    if (this.options.disableCache) {
      return;
    }

    let {assetGraphKey, requestGraphKey, snapshotKey} = this.getCacheKeys();
    await this.options.cache.set(assetGraphKey, this.assetGraph);
    await this.options.cache.set(requestGraphKey, this.requestGraph);

    let opts = this.getWatcherOptions();
    let snapshotPath = this.options.cache._getCachePath(snapshotKey, '.txt');
    await watcher.writeSnapshot(this.options.projectRoot, snapshotPath, opts);
  }
}

export class BuildAbortError extends Error {
  name = 'BuildAbortError';
}
