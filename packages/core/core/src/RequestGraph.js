// @flow strict-local

import type {FilePath, Glob} from '@parcel/types';
import type {Config, ParcelOptions} from './types';

import invariant from 'assert';
//$FlowFixMe
import {isMatch} from 'micromatch';
import nullthrows from 'nullthrows';
import path from 'path';

import {PromiseQueue, md5FromString, md5FromObject} from '@parcel/utils';
import type {Event} from '@parcel/watcher';
import WorkerFarm from '@parcel/workers';

import {addDevDependency} from './InternalConfig';
import ConfigLoader from './ConfigLoader';
import type {Dependency} from './types';
import Graph, {type GraphOpts} from './Graph';
import type ParcelConfig from './ParcelConfig';
import ResolverRunner from './ResolverRunner';
import type {
  Asset as AssetValue,
  AssetRequest,
  AssetRequestNode,
  ConfigRequest,
  ConfigRequestNode,
  DepPathRequestNode,
  DepVersionRequestNode,
  NodeId,
  RequestGraphNode,
  RequestNode,
  SubRequestNode,
  TransformationOpts,
  ValidationOpts
} from './types';

type RequestGraphOpts = {|
  ...GraphOpts<RequestGraphNode>,
  config: ParcelConfig,
  options: ParcelOptions,
  onAssetRequestComplete: (AssetRequestNode, Array<AssetValue>) => mixed,
  onDepPathRequestComplete: (DepPathRequestNode, AssetRequest | null) => mixed,
  workerFarm: WorkerFarm
|};

type SerializedRequestGraph = {|
  ...GraphOpts<RequestGraphNode>,
  invalidNodeIds: Set<NodeId>,
  globNodeIds: Set<NodeId>,
  depVersionRequestNodeIds: Set<NodeId>
|};

const nodeFromDepPathRequest = (dep: Dependency) => ({
  id: dep.id,
  type: 'dep_path_request',
  value: dep
});

const nodeFromConfigRequest = (configRequest: ConfigRequest) => ({
  id: md5FromString(
    `${configRequest.filePath}:${
      configRequest.plugin != null ? configRequest.plugin : 'parcel'
    }`
  ),
  type: 'config_request',
  value: configRequest
});

const nodeFromDepVersionRequest = depVersionRequest => ({
  id: md5FromObject(depVersionRequest),
  type: 'dep_version_request',
  value: depVersionRequest
});

const nodeFromFilePath = (filePath: string) => ({
  id: filePath,
  type: 'file',
  value: {filePath}
});

const nodeFromGlob = (glob: Glob) => ({
  id: glob,
  type: 'glob',
  value: glob
});

export default class RequestGraph extends Graph<RequestGraphNode> {
  // $FlowFixMe
  inProgress: Map<NodeId, Promise<any>> = new Map();
  invalidNodeIds: Set<NodeId> = new Set();
  runTransform: TransformationOpts => Promise<{
    assets: Array<AssetValue>,
    configRequests: Array<ConfigRequest>,
    ...
  }>;
  runValidate: ValidationOpts => Promise<void>;
  loadConfigHandle: () => Promise<Config>;
  resolverRunner: ResolverRunner;
  configLoader: ConfigLoader;
  onAssetRequestComplete: (AssetRequestNode, Array<AssetValue>) => mixed;
  onDepPathRequestComplete: (DepPathRequestNode, AssetRequest | null) => mixed;
  queue: PromiseQueue<mixed>;
  validationQueue: PromiseQueue<mixed>;
  farm: WorkerFarm;
  config: ParcelConfig;
  options: ParcelOptions;
  globNodeIds: Set<NodeId> = new Set();
  depVersionRequestNodeIds: Set<NodeId> = new Set();

  // $FlowFixMe
  static deserialize(opts: SerializedRequestGraph) {
    let deserialized = new RequestGraph(opts);
    deserialized.invalidNodeIds = opts.invalidNodeIds;
    deserialized.globNodeIds = opts.globNodeIds;
    deserialized.depVersionRequestNodeIds = opts.depVersionRequestNodeIds;
    // $FlowFixMe
    return deserialized;
  }

  // $FlowFixMe
  serialize(): SerializedRequestGraph {
    return {
      ...super.serialize(),
      invalidNodeIds: this.invalidNodeIds,
      globNodeIds: this.globNodeIds,
      depVersionRequestNodeIds: this.depVersionRequestNodeIds
    };
  }

  initOptions({
    onAssetRequestComplete,
    onDepPathRequestComplete,
    config,
    options,
    workerFarm
  }: RequestGraphOpts) {
    this.options = options;
    this.queue = new PromiseQueue();
    this.validationQueue = new PromiseQueue();
    this.onAssetRequestComplete = onAssetRequestComplete;
    this.onDepPathRequestComplete = onDepPathRequestComplete;
    this.config = config;

    this.resolverRunner = new ResolverRunner({
      config,
      options
    });

    this.farm = workerFarm;
    this.runTransform = this.farm.createHandle('runTransform');
    this.runValidate = this.farm.createHandle('runValidate');
    // $FlowFixMe
    this.loadConfigHandle = this.farm.createReverseHandle(
      this.loadConfig.bind(this)
    );
    this.configLoader = new ConfigLoader(options);
  }

  async completeValidations() {
    await this.validationQueue.run();
  }

  async completeRequests() {
    for (let id of this.invalidNodeIds) {
      let node = nullthrows(this.getNode(id));
      this.processNode(node);
    }

    await this.queue.run();
  }

  addNode(node: RequestGraphNode) {
    this.invalidNodeIds.add(node.id);
    if (node.type === 'glob') {
      this.globNodeIds.add(node.id);
    } else if (node.type === 'dep_version_request') {
      this.depVersionRequestNodeIds.add(node.id);
    }
    this.processNode(node);
    return super.addNode(node);
  }

  removeNode(node: RequestGraphNode) {
    if (node.type === 'glob') {
      this.globNodeIds.delete(node.id);
    } else if (node.type === 'dep_version_request') {
      this.depVersionRequestNodeIds.delete(node.id);
    }
    this.invalidNodeIds.delete(node.id);
    return super.removeNode(node);
  }

  addDepPathRequest(dep: Dependency) {
    let requestNode = nodeFromDepPathRequest(dep);
    if (!this.hasNode(requestNode.id)) {
      this.addNode(requestNode);
    }
  }

  addAssetRequest(id: NodeId, request: AssetRequest) {
    let requestNode = {id, type: 'asset_request', value: request};
    if (!this.hasNode(requestNode.id)) {
      this.addNode(requestNode);
    }

    this.connectFile(requestNode, request.filePath);
  }

  async processNode(requestNode: RequestGraphNode) {
    let promise;
    switch (requestNode.type) {
      case 'asset_request':
        promise = this.queue.add(() =>
          this.transform(requestNode).then(result => {
            this.onAssetRequestComplete(requestNode, result);
            return result;
          })
        );

        if (
          !requestNode.value.filePath.includes('node_modules') &&
          this.config.getValidatorNames(requestNode.value.filePath).length > 0
        ) {
          this.validationQueue.add(() => this.validate(requestNode));
        }

        break;
      case 'dep_path_request':
        promise = this.queue.add(() =>
          this.resolvePath(requestNode.value).then(result => {
            this.onDepPathRequestComplete(requestNode, result);
            return result;
          })
        );
        break;
      case 'config_request':
        promise = this.runConfigRequest(requestNode);
        break;
      case 'dep_version_request':
        promise = this.runDepVersionRequest(requestNode);
        break;
      default:
        this.invalidNodeIds.delete(requestNode.id);
    }

    if (promise) {
      try {
        this.inProgress.set(requestNode.id, promise);
        await promise;
        // ? Should these be updated before it comes off the queue?
        this.invalidNodeIds.delete(requestNode.id);
      } catch (e) {
        // Do nothing
        // Main tasks will be caught by the queue
        // Sub tasks will end up rejecting the main task promise
      } finally {
        this.inProgress.delete(requestNode.id);
      }
    }
  }

  async validate(requestNode: AssetRequestNode) {
    try {
      await this.runValidate({
        request: requestNode.value,
        loadConfig: this.loadConfigHandle,
        parentNodeId: requestNode.id,
        options: this.options
      });
    } catch (e) {
      throw e;
    }
  }

  async transform(requestNode: AssetRequestNode) {
    try {
      let start = Date.now();
      let request = requestNode.value;
      let {assets, configRequests} = await this.runTransform({
        request,
        loadConfig: this.loadConfigHandle,
        parentNodeId: requestNode.id,
        options: this.options
      });

      let time = Date.now() - start;
      for (let asset of assets) {
        asset.stats.time = time;
      }

      let configRequestNodes = configRequests.map(configRequest => {
        let id = nodeFromConfigRequest(configRequest).id;
        return nullthrows(this.getNode(id));
      });
      this.replaceNodesConnectedTo(
        requestNode,
        configRequestNodes,
        node => node.type === 'config_request'
      );

      return assets;
    } catch (e) {
      // TODO: add connectedFiles even if it failed so we can try a rebuild if those files change
      throw e;
    }
  }

  async resolvePath(dep: Dependency) {
    try {
      let assetRequest = await this.resolverRunner.resolve(dep);

      this.connectFile(nodeFromDepPathRequest(dep), assetRequest.filePath);
      return assetRequest;
    } catch (err) {
      if (err.code === 'MODULE_NOT_FOUND' && dep.isOptional) {
        return null;
      }

      throw err;
    }
  }

  async loadConfig(configRequest: ConfigRequest, parentNodeId: NodeId) {
    let configRequestNode = nodeFromConfigRequest(configRequest);
    if (!this.hasNode(configRequestNode.id)) {
      this.addNode(configRequestNode);
    }
    this.addEdge(parentNodeId, configRequestNode.id);

    let config = nullthrows(await this.getSubTaskResult(configRequestNode));
    invariant(config.devDeps != null);

    let depVersionRequestNodes = [];
    for (let [moduleSpecifier, version] of config.devDeps) {
      let depVersionRequest = {
        moduleSpecifier,
        resolveFrom: path.dirname(nullthrows(config.resolvedPath)) // TODO: resolveFrom should be nearest package boundary
      };
      let depVersionRequestNode = nodeFromDepVersionRequest(depVersionRequest);
      if (!this.hasNode(depVersionRequestNode.id)) {
        this.addNode(depVersionRequestNode);
      }
      this.addEdge(configRequestNode.id, depVersionRequestNode.id);
      depVersionRequestNodes.push(
        nullthrows(this.getNode(depVersionRequestNode.id))
      );

      if (version == null) {
        let result = await this.getSubTaskResult(depVersionRequestNode);
        addDevDependency(config, depVersionRequest.moduleSpecifier, result);
      }
    }
    this.replaceNodesConnectedTo(
      configRequestNode,
      depVersionRequestNodes,
      node => node.type === 'dep_version_request'
    );

    return config;
  }

  async runConfigRequest(configRequestNode: ConfigRequestNode) {
    let configRequest = configRequestNode.value;
    let config = await this.configLoader.load(configRequest);
    configRequest.result = config;

    let invalidationNodes = [];

    if (config.resolvedPath != null) {
      invalidationNodes.push(nodeFromFilePath(config.resolvedPath));
    }

    for (let filePath of config.includedFiles) {
      invalidationNodes.push(nodeFromFilePath(filePath));
    }

    if (config.watchGlob != null) {
      invalidationNodes.push(nodeFromGlob(config.watchGlob));
    }

    this.replaceNodesConnectedTo(
      configRequestNode,
      invalidationNodes,
      node => node.type === 'file' || node.type === 'glob'
    );

    return config;
  }

  async runDepVersionRequest(requestNode: DepVersionRequestNode) {
    let {value: request} = requestNode;
    let {moduleSpecifier, resolveFrom} = request;
    let {pkg} = await this.options.packageManager.resolve(
      `${moduleSpecifier}/package.json`,
      `${resolveFrom}/index`
    );

    // TODO: Figure out how to handle when local plugin packages change, since version won't be enough
    let version = nullthrows(pkg).version;
    request.result = version;

    return version;
  }

  //$FlowFixMe
  async getSubTaskResult(node: SubRequestNode): any {
    let result;
    if (this.inProgress.has(node.id)) {
      result = await this.inProgress.get(node.id);
    } else {
      result = this.getResultFromGraph(node);
    }

    return result;
  }

  getResultFromGraph(subRequestNode: SubRequestNode) {
    let node = nullthrows(this.getNode(subRequestNode.id));
    invariant(
      node.type === 'config_request' || node.type === 'dep_version_request'
    );
    return node.value.result;
  }

  connectFile(requestNode: RequestNode, filePath: FilePath) {
    let fileNode = nodeFromFilePath(filePath);
    if (!this.hasNode(fileNode.id)) {
      this.addNode(fileNode);
    }

    if (!this.hasEdge(requestNode.id, fileNode.id)) {
      this.addEdge(requestNode.id, fileNode.id);
    }
  }

  connectGlob(requestNode: RequestNode, glob: Glob) {
    let globNode = nodeFromGlob(glob);
    if (!this.hasNode(globNode.id)) {
      this.addNode(globNode);
    }

    if (!this.hasEdge(requestNode.id, globNode.id)) {
      this.addEdge(requestNode.id, globNode.id);
    }
  }

  invalidateNode(node: RequestNode) {
    switch (node.type) {
      case 'asset_request':
      case 'dep_path_request':
        this.invalidNodeIds.add(node.id);
        break;
      case 'config_request':
      case 'dep_version_request': {
        this.invalidNodeIds.add(node.id);
        let mainRequestNode = nullthrows(this.getMainRequestNode(node));
        this.invalidNodeIds.add(mainRequestNode.id);
        break;
      }
      default:
        throw new Error(
          `Cannot invalidate node with unrecognized type ${node.type}`
        );
    }
  }

  getMainRequestNode(node: SubRequestNode) {
    let [parentNode] = this.getNodesConnectedTo(node);
    if (parentNode.type === 'config_request') {
      [parentNode] = this.getNodesConnectedTo(parentNode);
    }
    invariant(parentNode.type !== 'file' && parentNode.type !== 'glob');
    return parentNode;
  }

  // TODO: add edge types to make invalidation more flexible and less precarious
  respondToFSEvents(events: Array<Event>): boolean {
    let isInvalid = false;
    for (let {path, type} of events) {
      if (path === this.options.lockFile) {
        for (let id of this.depVersionRequestNodeIds) {
          let depVersionRequestNode = this.getNode(id);
          invariant(
            depVersionRequestNode &&
              depVersionRequestNode.type === 'dep_version_request'
          );

          this.invalidateNode(depVersionRequestNode);
          isInvalid = true;
        }
      }

      let node = this.getNode(path);

      let connectedNodes =
        node && node.type === 'file' ? this.getNodesConnectedTo(node) : [];

      // TODO: invalidate dep path requests that have failed and this creation may fulfill the request
      if (node && (type === 'create' || type === 'update')) {
        // sometimes mac reports update events as create events
        if (node.type === 'file') {
          for (let connectedNode of connectedNodes) {
            if (
              connectedNode.type === 'asset_request' ||
              connectedNode.type === 'config_request'
            ) {
              this.invalidateNode(connectedNode);
              isInvalid = true;
            }
          }
        }
      } else if (type === 'create') {
        for (let id of this.globNodeIds) {
          let globNode = this.getNode(id);
          invariant(globNode && globNode.type === 'glob');

          if (isMatch(path, globNode.value)) {
            let connectedNodes = this.getNodesConnectedTo(globNode);
            for (let connectedNode of connectedNodes) {
              invariant(
                connectedNode.type !== 'file' && connectedNode.type !== 'glob'
              );
              this.invalidateNode(connectedNode);
              isInvalid = true;
            }
          }
        }
      } else if (node && type === 'delete') {
        for (let connectedNode of connectedNodes) {
          if (
            connectedNode.type === 'dep_path_request' ||
            connectedNode.type === 'config_request'
          ) {
            this.invalidateNode(connectedNode);
            isInvalid = true;
          }
        }
      }
    }

    return isInvalid;
  }
}
