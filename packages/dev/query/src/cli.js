// @flow strict-local
/* eslint-disable no-console, monorepo/no-internal-import */
import type {ContentGraph, ContentKey, NodeId} from '@parcel/graph';
import type {BundleGraphEdgeType} from '@parcel/core/src/BundleGraph';
import type {AssetGraphNode, BundleGraphNode} from '@parcel/core/src/types';

import path from 'path';
import fs from 'fs';
import repl from 'repl';
import os from 'os';
import nullthrows from 'nullthrows';
import invariant from 'assert';
import {serialize} from 'v8';
// $FlowFixMe
import {table} from 'table';

import {loadGraphs} from './index.js';

const {
  BundleGraph: {bundleGraphEdgeTypes: bundleGraphEdgeTypes},
  Priority,
  fromProjectPathRelative,
} = require('./deep-imports.js');

export async function run(input: string[]) {
  let args = input;
  let cacheDir = path.join(process.cwd(), '.parcel-cache');
  if (args[0] === '--cache') {
    cacheDir = path.resolve(process.cwd(), args[1]);
    args = args.slice(2);
  }
  let initialCmd = args[0];

  try {
    fs.accessSync(cacheDir);
  } catch (e) {
    console.error("Can't find cache dir", cacheDir);
    process.exit(1);
  }

  console.log('Loading graphs...');
  let {assetGraph, bundleGraph, bundleInfo, requestTracker, cacheInfo} =
    await loadGraphs(cacheDir);

  function hasRequestTracker() {
    if (requestTracker == null) {
      console.error('Request Graph could not be found');
      return false;
    }
    return true;
  }

  function hasBundleGraph() {
    if (bundleGraph == null) {
      console.error('Bundle Graph could not be found');
      return false;
    }
    return true;
  }

  function hasAssetGraph() {
    if (assetGraph == null) {
      console.error('Asset Graph could not be found');
      return false;
    }
    return true;
  }

  function hasBundleInfo() {
    if (bundleInfo == null) {
      console.error('Bundle Info could not be found');
      return false;
    }
    return true;
  }

  // -------------------------------------------------------

  function getBundleFilePath(id: ContentKey) {
    if (!hasBundleInfo()) {
      return;
    }
    invariant(bundleInfo != null);
    return fromProjectPathRelative(
      nullthrows(bundleInfo.get(id)?.[0].filePath),
    );
  }

  function parseAssetLocator(v: string) {
    let id: ?string = null;
    if (v.length === 16) {
      id = v;
    } else {
      if (!hasBundleGraph()) {
        return;
      }
      invariant(bundleGraph != null);
      for (let [assetId, publicId] of bundleGraph._publicIdByAssetId) {
        if (publicId === v) {
          id = assetId;
          break;
        }
      }
    }

    if (id == null && v.length > 0) {
      if (!hasAssetGraph()) {
        return;
      }
      invariant(assetGraph != null);
      let assetRegex = new RegExp(v);
      for (let node of assetGraph.nodes.values()) {
        if (
          node?.type === 'asset' &&
          assetRegex.test(fromProjectPathRelative(node.value.filePath))
        ) {
          id = node.id;
          break;
        }
      }
    }
    return id;
  }

  function parseBundleLocator(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bundleRegex = new RegExp(v);
    for (let b of bundleGraph.getBundles()) {
      let bundleFilePath = getBundleFilePath(b.id);
      if (
        (bundleFilePath !== undefined && bundleRegex.test(bundleFilePath)) ||
        b.id === v
      ) {
        return b.id;
      }
    }
  }

  function getAsset(v: string) {
    let id: ?string = parseAssetLocator(v);

    if (id == null) {
      console.log(null);
    } else {
      try {
        if (!hasBundleGraph()) {
          return;
        }
        invariant(bundleGraph != null);
        let asset = bundleGraph.getAssetById(id);
        console.log('Public id', bundleGraph.getAssetPublicId(asset));
        console.log(asset);
      } catch (e) {
        if (!hasAssetGraph()) {
          return;
        }
        invariant(assetGraph != null);
        let node = nullthrows(assetGraph.getNodeByContentKey(id));
        invariant(node.type === 'asset');
        console.log(node.value);
      }
    }
  }

  function _findAssetNode(v: string) {
    if (!hasAssetGraph()) {
      return;
    }
    invariant(assetGraph != null);
    let assetRegex = new RegExp(v);
    for (let node of assetGraph.nodes.values()) {
      if (
        node?.type === 'asset' &&
        assetRegex.test(fromProjectPathRelative(node.value.filePath))
      ) {
        return node;
      }
    }
  }

  function findAsset(v: string) {
    let node = _findAssetNode(v);
    if (node) {
      try {
        if (!hasBundleGraph()) {
          return;
        }
        invariant(bundleGraph != null);
        console.log(
          `${bundleGraph.getAssetPublicId(
            bundleGraph.getAssetById(node.id),
          )} ${fromProjectPathRelative(node.value.filePath)}`,
        );
      } catch (e) {
        console.log(fromProjectPathRelative(node.value.filePath));
      }
    }
  }

  function findAssetWithSymbol(local: string) {
    if (!hasBundleGraph() || !hasAssetGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    invariant(assetGraph != null);
    let [, assetId, binding, ref] = nullthrows(
      local.match(/^\$([^$]+)\$([^$]+)\$(.*)$/),
      `symbol ${local} could not be resolved`,
    );

    let asset;
    // Search against the id used by the JSTransformer and ScopeHoistingPackager,
    // not the final asset id, as it may have changed with further transformation.
    for (let node of assetGraph.nodes.values()) {
      if (node?.type === 'asset' && node.value.meta.id === assetId) {
        asset = node;
        break;
      }
    }

    // If the asset couldn't be found by searching for the id,
    // search for the local name in asset used symbols.
    if (asset == null) {
      outer: for (let node of assetGraph.nodes.values()) {
        if (node?.type === 'asset' && node.value.symbols) {
          for (let symbol of node.value.symbols.values()) {
            if (symbol.local === local) {
              asset = node;
              break outer;
            }
          }
        }
      }
    }

    invariant(asset, `An asset for ${assetId} could not be found`);
    invariant(
      asset.type === 'asset',
      `Expected ${assetId} to be an asset, but found a ${asset.type}`,
    );

    try {
      console.log(
        `${bundleGraph.getAssetPublicId(
          bundleGraph.getAssetById(asset.id),
        )} ${fromProjectPathRelative(asset.value.filePath)}`,
      );
    } catch (e) {
      console.log(fromProjectPathRelative(asset.value.filePath));
    }
    if (binding === 'export' && asset.value.symbols) {
      for (let [symbolName, symbol] of asset.value.symbols) {
        if (symbol.local === local) {
          if (symbol.loc) {
            let locPath = symbol.loc.filePath;
            let locAsset = _findAssetNode(String(locPath));
            if (locAsset != null) {
              try {
                console.log(
                  `${bundleGraph.getAssetPublicId(
                    bundleGraph.getAssetById(locAsset.id),
                  )} ${fromProjectPathRelative(locAsset.value.filePath)}`,
                );
              } catch (e) {
                console.log(
                  `imported as ${symbolName} from ${fromProjectPathRelative(
                    locAsset.value.filePath,
                  )}`,
                );
              }
            } else {
              console.log(
                `imported as ${symbolName} from ${fromProjectPathRelative(
                  locPath,
                )}`,
              );
            }
          } else {
            console.log(`imported as ${symbolName}`);
          }
        }
      }
    } else if (ref) {
      console.log(`possibly defined as ${ref}`);
    }
  }

  function getNodeAssetGraph(v: string) {
    if (!hasAssetGraph()) {
      return;
    }
    invariant(assetGraph != null);
    console.log(assetGraph.getNodeByContentKey(v));
  }
  function getNodeBundleGraph(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    console.log(bundleGraph._graph.getNodeByContentKey(v));
  }

  class Paths<T> {
    value: T;
    label: string;
    suffix: string;
    children: Array<Paths<T>> = [];
    constructor(value: T, label = '-', suffix = '') {
      this.value = value;
      this.label = label;
      this.suffix = suffix;
    }
    add(v: T, label: string | void, suffix: string | void): Paths<T> {
      let next = new Paths(v, label, suffix);
      this.children.push(next);
      return next;
    }
    print(format: T => string, prefix = '') {
      console.log(
        `${prefix}${this.label} ${format(this.value)} ${this.suffix}`,
      );
      for (let i = 0; i < this.children.length; i++) {
        this.children[i].print(format, prefix + '  ');
      }
    }
  }

  function _findEntries(
    graph:
      | ContentGraph<BundleGraphNode, BundleGraphEdgeType>
      | ContentGraph<AssetGraphNode>,
    v: string,
  ) {
    let asset = nullthrows(parseAssetLocator(v), 'Asset not found');

    let paths = new Paths<NodeId>(graph.getNodeIdByContentKey(asset), ' ');
    let cb = (id, ctx, revisiting) => {
      let {paths, lazyOutgoing} = ctx;
      let node = nullthrows(graph.getNode(id));
      if (node.id === asset) return ctx;
      if (node.type === 'asset') {
        paths = paths.add(
          id,
          lazyOutgoing ? '<' : undefined,
          revisiting ? '(revisiting)' : undefined,
        );
        lazyOutgoing = false;
      } else if (node.type === 'dependency') {
        if (node.value.priority === Priority.lazy) {
          lazyOutgoing = true;
        }
      }
      return {paths, lazyOutgoing};
    };

    // like graph.dfs, but revisiting nodes and skipping its children
    let seen = new Set();
    function walk(id, ctx) {
      let revisiting = seen.has(id);
      let newCtx = cb(id, ctx, revisiting);
      if (revisiting) return;
      seen.add(id);

      for (let parent of graph.getNodeIdsConnectedTo(id)) {
        walk(parent, newCtx);
      }
    }
    walk(graph.getNodeIdByContentKey(asset), {paths, lazyOutgoing: false});

    paths.print(id => {
      let node = nullthrows(graph.getNode(id));
      invariant(node.type === 'asset');
      return fromProjectPathRelative(node.value.filePath);
    });
  }

  function findEntriesAssetGraph(v: string) {
    if (!hasAssetGraph()) {
      return;
    }
    invariant(assetGraph != null);
    _findEntries(assetGraph, v);
  }
  function findEntriesBundleGraph(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    _findEntries(bundleGraph._graph, v);
  }
  function findEntries(v: string) {
    findEntriesBundleGraph(v);
  }

  function getBundlesWithAsset(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let asset = nullthrows(parseAssetLocator(v), 'Asset not found');
    for (let b of bundleGraph.getBundlesWithAsset(
      bundleGraph.getAssetById(asset),
    )) {
      let bundleFilePath = getBundleFilePath(b.id);
      if (bundleFilePath !== undefined) {
        console.log(
          `${b.id} ${bundleFilePath} ${
            b.mainEntryId != null ? `(main: ${b.mainEntryId})` : ''
          }`,
        );
      }
    }
  }

  function getBundlesWithDependency(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let node = nullthrows(bundleGraph._graph.getNodeByContentKey(v));
    invariant(node.type === 'dependency');

    for (let b of bundleGraph.getBundlesWithDependency(node.value)) {
      let bundleFilePath = getBundleFilePath(b.id);
      if (bundleFilePath !== undefined) {
        console.log(
          `${b.id} ${bundleFilePath} ${
            b.mainEntryId != null ? `(main: ${b.mainEntryId})` : ''
          }`,
        );
      }
    }
  }

  // eslint-disable-next-line no-unused-vars
  function getBundles(_) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    for (let b of bundleGraph.getBundles()) {
      let bundleFilePath = getBundleFilePath(b.id);
      if (bundleFilePath !== undefined) {
        console.log(
          `${b.id} ${bundleFilePath} ${
            b.mainEntryId != null ? `(main: ${b.mainEntryId})` : ''
          }`,
        );
      }
    }
  }

  function getReferencingBundles(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bundleId = nullthrows(parseBundleLocator(v), 'Bundle not found');
    let bundleNodeId = bundleGraph._graph.getNodeIdByContentKey(bundleId);
    let bundleNode = nullthrows(
      bundleGraph._graph.getNode(bundleNodeId),
      'Bundle not found',
    );
    invariant(bundleNode.type === 'bundle', 'Not a bundle');

    for (let b of bundleGraph.getReferencingBundles(bundleNode.value)) {
      let bundleFilePath = getBundleFilePath(b.id);
      if (bundleFilePath !== undefined) {
        console.log(
          `${b.id} ${bundleFilePath} ${
            b.mainEntryId != null ? `(main: ${b.mainEntryId})` : ''
          }`,
        );
      }
    }
  }

  function getIncomingDependenciesAssetGraph(v: string) {
    if (!hasAssetGraph()) {
      return;
    }
    invariant(assetGraph != null);
    let asset = nullthrows(parseAssetLocator(v), 'Asset not found');
    let node = nullthrows(assetGraph.getNodeByContentKey(asset));
    invariant(node.type === 'asset');

    console.log(assetGraph.getIncomingDependencies(node.value));
  }
  function getIncomingDependenciesBundleGraph(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let asset = nullthrows(parseAssetLocator(v), 'Asset not found');
    let value = nullthrows(bundleGraph.getAssetById(asset));

    console.log(bundleGraph.getIncomingDependencies(value));
  }

  function getIncomingDependencies(v: string) {
    getIncomingDependenciesBundleGraph(v);
  }

  function getResolvedAsset(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let node = nullthrows(
      bundleGraph._graph.getNodeByContentKey(v),
      'Dependency not found',
    );
    invariant(
      node.type === 'dependency',
      'Node is not a dependency, but a ' + node.type,
    );
    console.log(bundleGraph.getResolvedAsset(node.value));
  }

  function getAssetWithDependency(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let node = nullthrows(
      bundleGraph._graph.getNodeByContentKey(v),
      'Dependency not found',
    );
    invariant(
      node.type === 'dependency',
      'Node is not a dependency, but a ' + node.type,
    );
    console.log(bundleGraph.getAssetWithDependency(node.value));
  }

  function traverseAssets(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bundleId = nullthrows(parseBundleLocator(v), 'Bundle not found');
    let node = nullthrows(
      bundleGraph._graph.getNodeByContentKey(bundleId),
      'Bundle not found',
    );
    invariant(
      node.type === 'bundle',
      'Node is not a bundle, but a ' + node.type,
    );

    bundleGraph.traverseAssets(node.value, asset => {
      console.log(asset.id, asset.filePath);
    });
  }
  function traverseBundle(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bundleId = nullthrows(parseBundleLocator(v), 'Bundle not found');
    let node = nullthrows(
      bundleGraph._graph.getNodeByContentKey(bundleId),
      'Bundle not found',
    );
    invariant(
      node.type === 'bundle',
      'Node is not a bundle, but a ' + node.type,
    );

    bundleGraph.traverseBundle(node.value, node => {
      if (node.type === 'asset') {
        console.log(node.id, node.value.filePath);
      } else {
        console.log(
          node.id,
          node.value.sourcePath,
          '->',
          node.value.specifier,
          node.value.symbols
            ? `(${[...node.value.symbols.keys()].join(',')})`
            : '',
          node.excluded ? `- excluded` : '',
        );
      }
    });
  }

  function getBundle(v: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bundleRegex = new RegExp(v);
    for (let b of bundleGraph.getBundles()) {
      let bundleFilePath = getBundleFilePath(b.id);
      if (
        (bundleFilePath !== undefined && bundleRegex.test(bundleFilePath)) ||
        b.id === v
      ) {
        console.log(getBundleFilePath(b.id), b);
      }
    }
  }

  function findBundleReason(bundle: string, asset: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bundleId = nullthrows(parseBundleLocator(bundle), 'Bundle not found');
    let bundleNodeId = bundleGraph._graph.getNodeIdByContentKey(bundleId);
    let bundleNode = nullthrows(
      bundleGraph._graph.getNode(bundleNodeId),
      'Bundle not found',
    );
    invariant(bundleNode.type === 'bundle', 'Not a bundle');
    let assetId = nullthrows(parseAssetLocator(asset), 'Asset not found');
    let assetNodeId = bundleGraph._graph.getNodeIdByContentKey(assetId);
    let assetNode = nullthrows(
      bundleGraph._graph.getNode(assetNodeId),
      'Asset not found',
    );
    invariant(assetNode.type === 'asset', 'Not an asset');

    invariant(
      bundleGraph._graph.hasEdge(
        bundleNodeId,
        assetNodeId,
        bundleGraphEdgeTypes.contains,
      ),
      'Asset is not part of the bundle',
    );

    console.log(
      '# Asset is main entry of bundle:',
      bundleNode.value.mainEntryId === assetId,
    );

    console.log(
      '# Asset is an entry of bundle:',
      bundleNode.value.entryAssetIds.includes(assetId),
    );

    console.log('# Incoming dependencies contained in the bundle:');
    for (let incoming of bundleGraph._graph.getNodeIdsConnectedTo(
      assetNodeId,
    )) {
      if (
        bundleGraph._graph.hasEdge(
          bundleNodeId,
          incoming,
          bundleGraphEdgeTypes.contains,
        )
      ) {
        console.log(bundleGraph._graph.getNode(incoming));
      }
    }

    console.log(
      '# Incoming dependencies contained in referencing bundles (using this bundle as a shared bundle)',
    );
    let referencingBundles = bundleGraph.getReferencingBundles(
      bundleNode.value,
    );
    for (let incoming of bundleGraph._graph.getNodeIdsConnectedTo(
      assetNodeId,
    )) {
      if (
        referencingBundles.some(ref =>
          bundleGraph._graph.hasEdge(
            bundleGraph._graph.getNodeIdByContentKey(ref.id),
            incoming,
            bundleGraphEdgeTypes.contains,
          ),
        )
      ) {
        console.log(bundleGraph._graph.getNode(incoming));
      }
    }
  }

  function _getIncomingNodeOfType(bundleGraph, node, type: string) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    const bundleGraphNodeId = bundleGraph._graph.getNodeIdByContentKey(node.id);
    return bundleGraph._graph
      .getNodeIdsConnectedTo(bundleGraphNodeId, -1)
      .map(id => nullthrows(bundleGraph._graph.getNode(id)))
      .find(node => node.type == type);
  }

  // We find the priority of a Bundle or BundleGroup by looking at its incoming dependencies.
  // If a Bundle does not have an incoming dependency, we look for an incoming BundleGroup and its dependency
  // e.g. Dep(priority = 1) -> BundleGroup -> Bundle means that the Bundle has priority 1.
  function _getBundlePriority(bundleGraph, bundle) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let node = _getIncomingNodeOfType(bundleGraph, bundle, 'dependency');

    if (node == null) {
      node = _getIncomingNodeOfType(bundleGraph, bundle, 'bundle_group');
      if (node == null) return null;
      node = _getIncomingNodeOfType(bundleGraph, node, 'dependency');
    }

    if (node == null) return null;

    invariant(node.type === 'dependency', 'Not a dependency');

    return node.value.priority;
  }

  function _findEntryBundle(bundleGraph, node) {
    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    const bundleGraphNodeId = bundleGraph._graph.getNodeIdByContentKey(node.id);
    const entryBundleGroup = bundleGraph._graph
      .getNodeIdsConnectedTo(bundleGraphNodeId, -1)
      .map(id => nullthrows(bundleGraph._graph.getNode(id)))
      .find(
        node =>
          node.type === 'bundle_group' &&
          bundleGraph.isEntryBundleGroup(node.value),
      );

    return entryBundleGroup;
  }
  // eslint-disable-next-line no-unused-vars
  function inspectCache(_) {
    // displays sizing of various entries of the cache
    let table: Array<Array<string | number>> = [];
    table.push([
      'Graphs',
      'Size (bytes)',
      'Deserialize (ms)',
      'Serialize (ms)',
    ]);
    let serialized: Map<string, number> = new Map();
    serialized.set('RequestGraph', timeSerialize(requestTracker));
    serialized.set('BundleGraph', timeSerialize(bundleGraph));
    serialized.set('AssetGraph', timeSerialize(assetGraph));
    for (let [name, info] of nullthrows(cacheInfo).entries()) {
      if (
        (name === 'RequestGraph' && !hasRequestTracker()) ||
        (name === 'BundleGraph' && !hasBundleGraph()) ||
        (name === 'AssetGraph' && !hasAssetGraph())
      ) {
        continue;
      }
      let s = serialized.get(name);
      invariant(s != null);
      table.push([name, ...info, s]);
    }
    function getColumnSum(t: Array<Array<string | number>>, col: number) {
      if (t == null) {
        return '';
      }
      const initialValue = 0;
      let column = t.map(r => r[col]);
      column.shift();
      invariant(column != null);
      return column.reduce(
        (accumulator, currentValue) => accumulator + currentValue,
        initialValue,
      );
    }
    table.push([
      'Totals',
      getColumnSum(table, 1),
      getColumnSum(table, 2),
      getColumnSum(table, 3),
    ]);
    _printStatsTable('Cache Info', table);
  }

  function timeSerialize(graph) {
    let date = Date.now();
    serialize(graph);
    date = Date.now() - date;
    return date;
  }
  function _printStatsTable(header, data) {
    const config = {
      columnDefault: {
        width: 18,
      },
      header: {
        alignment: 'center',
        content: header,
      },
    };

    console.log(table(data, config));
  }

  // eslint-disable-next-line no-unused-vars
  function stats(_) {
    let ag = {
      asset: 0,
      dependency: 0,
      asset_group: 0,
    };

    if (hasAssetGraph()) {
      invariant(assetGraph != null);
      for (let n of assetGraph.nodes) {
        if (n && n.type in ag) {
          // $FlowFixMe
          ag[n.type]++;
        }
      }
      _printStatsTable('# Asset Graph Node Counts', Object.entries(ag));
    }

    if (!hasBundleGraph()) {
      return;
    }
    invariant(bundleGraph != null);
    let bg = {
      dependency: 0,
      bundle: 0,
      bundle_group: 0,
      asset_node_modules: 0,
      asset_source: 0,
    };

    let b_type = {
      entry: 0,
      shared: 0,
      async: 0,
      parallel: 0,
      sync: 0,
    };

    let b_ext = {};

    const entries = new Set();

    for (let n of bundleGraph._graph.nodes) {
      if (n?.type === 'bundle_group') {
        bg.bundle_group++;
      } else if (n?.type === 'bundle') {
        bg.bundle++;

        // $FlowFixMe
        b_ext[n.value.type] = (b_ext[n.value.type] || 0) + 1;

        // $FlowFixMe
        const entry_group = _findEntryBundle(bundleGraph, n);

        if (entry_group != null && !entries.has(entry_group.id)) {
          b_type.entry++;
          entries.add(entry_group.id);
        } else if (n.value.mainEntryId == null) {
          // In general, !bundle.mainEntryId means that it is shared. In the case of an async and shared bundle, only count it as shared.
          b_type.shared++;
        } else {
          const priority = _getBundlePriority(bundleGraph, n);

          if (priority == Priority.lazy) {
            b_type.async++;
          } else if (priority == Priority.parallel) {
            b_type.parallel++;
          } else if (priority == Priority.sync) {
            b_type.sync++;
          }
        }
      } else if (n?.type === 'asset') {
        if (
          // $FlowFixMe
          fromProjectPathRelative(n.value.filePath).includes('node_modules')
        ) {
          bg.asset_node_modules++;
        } else {
          bg.asset_source++;
        }
      } else if (n?.type === 'dependency') {
        bg.dependency++;
      }
    }

    _printStatsTable('# Bundle Graph Node Counts', Object.entries(bg));
    _printStatsTable('# Bundles By Type', Object.entries(b_type));
    _printStatsTable('# Bundles By Extension', Object.entries(b_ext));

    // Assert that counts for each breakdown are correct

    let sum_b_ext = 0;
    for (let k in b_ext) {
      sum_b_ext += b_ext[k];
    }

    let sum_b_type = 0;
    for (let k in b_type) {
      sum_b_type += b_type[k];
    }

    invariant(
      bg.bundle == sum_b_type,
      `Bundles by type ${sum_b_type} does not equal total ${bg.bundle}`,
    );
    invariant(
      bg.bundle == sum_b_ext,
      `Bundles by extension ${sum_b_ext} does not equal total ${bg.bundle}`,
    );
  }

  // -------------------------------------------------------

  if (initialCmd != null) {
    (async () => {
      await eval(initialCmd);
      process.exit(0);
    })();
  } else {
    console.log(
      'See .help. The graphs can be accessed via `assetGraph`, `bundleGraph` and `requestTracker`.',
    );
    process.on('uncaughtException', function (err) {
      console.error(err);
      server.displayPrompt();
    });

    const server = repl.start({useColors: true, useGlobal: true});
    // $FlowFixMe[prop-missing]
    server.setupHistory(
      path.join(os.homedir(), '.parcel_query_history'),
      () => {},
    );

    // $FlowFixMe[prop-missing]
    server.context.bundleGraph = bundleGraph;
    // $FlowFixMe[prop-missing]
    server.context.assetGraph = assetGraph;
    // $FlowFixMe[prop-missing]
    server.context.requestTracker = requestTracker;
    // $FlowFixMe[prop-missing]
    server.context.cacheInfo = cacheInfo;
    for (let [name, cmd] of new Map([
      [
        'getAsset',
        {
          help: 'args: <id | public id | filepath>',
          action: getAsset,
        },
      ],
      [
        'getNodeAssetGraph',
        {
          help: 'args: <content key>. Find node by content key in the asset graph',
          action: getNodeAssetGraph,
        },
      ],
      [
        'getNodeBundleGraph',
        {
          help: 'args: <content key>. Find node by content key in the bundle graph',
          action: getNodeBundleGraph,
        },
      ],
      [
        'findEntriesAssetGraph',
        {
          help: 'args: <id | public id | filepath>. List paths from an asset to entry points (in asset graph)',
          action: findEntriesAssetGraph,
        },
      ],
      [
        'findEntriesBundleGraph',
        {
          help: 'args: <id | public id | filepath>. List paths from an asset to entry points (in bundle graph)',
          action: findEntriesBundleGraph,
        },
      ],
      [
        'findEntries',
        {
          help: '= findEntriesBundleGraph',
          action: findEntries,
        },
      ],
      [
        'getBundlesWithAsset',
        {
          help: 'args: <id | public id | filepath>. Gets bundles containing the asset',
          action: getBundlesWithAsset,
        },
      ],
      [
        'getBundlesWithDependency',
        {
          help: 'args: <id>. Gets bundles containing the dependency',
          action: getBundlesWithDependency,
        },
      ],
      [
        'getIncomingDependenciesAssetGraph',
        {
          help: 'args: <asset: id | public id | filepath regex>',
          action: getIncomingDependenciesAssetGraph,
        },
      ],
      [
        'getIncomingDependenciesBundleGraph',
        {
          help: 'args: <asset: id | public id | filepath regex>',
          action: getIncomingDependenciesBundleGraph,
        },
      ],
      [
        'getIncomingDependencies',
        {
          help: '= getIncomingDependenciesBundleGraph',
          action: getIncomingDependencies,
        },
      ],
      [
        'getResolvedAsset',
        {
          help: 'args: <dependency id>. Resolve the dependency',
          action: getResolvedAsset,
        },
      ],
      [
        'getAssetWithDependency',
        {
          help: 'args: <dependency id>. Show which asset created the dependency',
          action: getAssetWithDependency,
        },
      ],
      [
        'traverseAssets',
        {
          help: 'args: <bundle id>. List assets in bundle',
          action: traverseAssets,
        },
      ],
      [
        'traverseBundle',
        {
          help: 'args: <bundle id>. List assets and dependencies in bundle',
          action: traverseBundle,
        },
      ],
      [
        'getBundle',
        {
          help: 'args: <name prefix|bundle id>. List matching bundles',
          action: getBundle,
        },
      ],
      [
        'findBundleReason',
        {
          help: 'args: <bundle> <asset>. Why is the asset in the bundle',
          action: v => findBundleReason(...v.split(' ')),
        },
      ],
      [
        'getBundles',
        {
          help: 'List all bundles',
          action: getBundles,
        },
      ],
      [
        'getReferencingBundles',
        {
          help: 'args: <bundle>. List bundles that reference the bundle',
          action: getReferencingBundles,
        },
      ],
      [
        'stats',
        {
          help: 'Statistics',
          action: stats,
        },
      ],
      [
        'findAsset',
        {
          help: 'args: <regex>. List assets matching the filepath regex',
          action: findAsset,
        },
      ],
      [
        'inspectCache',
        {
          help: 'Cache Information',
          action: inspectCache,
        },
      ],
      [
        'findAssetWithSymbol',
        {
          help: 'args: <local>. Get the asset that defines the symbol with the given local name',
          action: findAssetWithSymbol,
        },
      ],
    ])) {
      // $FlowFixMe
      server.context[name] = cmd.action;
      // $FlowFixMe
      server.defineCommand(name, {
        // $FlowFixMe
        help: '📦 ' + cmd.help,
        action: v => {
          // $FlowFixMe
          server.clearBufferedCommand();
          // $FlowFixMe
          try {
            cmd.action(v);
          } finally {
            server.displayPrompt();
          }
        },
      });
    }
  }
}
