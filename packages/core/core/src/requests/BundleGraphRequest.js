// @flow strict-local

import type {Async, Bundle as IBundle, Namer} from '@parcel/types';
import type {SharedReference} from '@parcel/workers';
import type ParcelConfig, {LoadedPlugin} from '../ParcelConfig';
import type {StaticRunOpts, RunAPI} from '../RequestTracker';
import type {
  Asset,
  AssetGroup,
  Bundle as InternalBundle,
  Config,
  DevDepRequest,
  ParcelOptions,
} from '../types';
import type {ConfigAndCachePath} from './ParcelConfigRequest';

import invariant from 'assert';
import assert from 'assert';
import nullthrows from 'nullthrows';
import {PluginLogger} from '@parcel/logger';
import ThrowableDiagnostic, {errorToDiagnostic} from '@parcel/diagnostic';
import AssetGraph from '../AssetGraph';
import BundleGraph from '../public/BundleGraph';
import InternalBundleGraph, {bundleGraphEdgeTypes} from '../BundleGraph';
import MutableBundleGraph from '../public/MutableBundleGraph';
import {Bundle, NamedBundle} from '../public/Bundle';
import {report} from '../ReporterRunner';
import dumpGraphToGraphViz from '../dumpGraphToGraphViz';
import {unique, setDifference} from '@parcel/utils';
import {hashString} from '@parcel/rust';
import PluginOptions from '../public/PluginOptions';
import applyRuntimes from '../applyRuntimes';
import {PARCEL_VERSION, OPTION_CHANGE} from '../constants';
import {assertSignalNotAborted, optionsProxy} from '../utils';
import createParcelConfigRequest, {
  getCachedParcelConfig,
} from './ParcelConfigRequest';
import {
  createDevDependency,
  getDevDepRequests,
  invalidateDevDeps,
  runDevDepRequest,
} from './DevDepRequest';
import {createConfig} from '../InternalConfig';
import {
  loadPluginConfig,
  runConfigRequest,
  type PluginWithLoadConfig,
} from './ConfigRequest';
import {
  joinProjectPath,
  fromProjectPathRelative,
  toProjectPathUnsafe,
} from '../projectPath';
import createAssetGraphRequest from './AssetGraphRequest';
import {tracer, PluginTracer} from '@parcel/profiler';
import {requestTypes} from '../RequestTracker';

type BundleGraphRequestInput = {|
  requestedAssetIds: Set<string>,
  signal?: AbortSignal,
  optionsRef: SharedReference,
|};

type BundleGraphRequestResult = {|
  bundleGraph: InternalBundleGraph,
|};

type RunInput = {|
  input: BundleGraphRequestInput,
  ...StaticRunOpts<BundleGraphResult>,
|};

// TODO: Rename to BundleGraphRequestResult
export type BundleGraphResult = {|
  bundleGraph: InternalBundleGraph,
  changedAssets: Map<string, Asset>,
  assetRequests: Array<AssetGroup>,
|};

type BundleGraphRequest = {|
  id: string,
  +type: typeof requestTypes.bundle_graph_request,
  run: RunInput => Async<BundleGraphResult>,
  input: BundleGraphRequestInput,
|};

export default function createBundleGraphRequest(
  input: BundleGraphRequestInput,
): BundleGraphRequest {
  return {
    type: requestTypes.bundle_graph_request,
    id: 'BundleGraph',
    run: async input => {
      let {options, api, invalidateReason} = input;
      let {optionsRef, requestedAssetIds, signal} = input.input;
      let measurement = tracer.createMeasurement('building');

      let request = createAssetGraphRequest({
        name: 'Main',
        entries: options.entries,
        optionsRef,
        shouldBuildLazily: options.shouldBuildLazily,
        lazyIncludes: options.lazyIncludes,
        lazyExcludes: options.lazyExcludes,
        requestedAssetIds,
      });

      let {assetGraph, changedAssets, assetRequests} = await api.runRequest(
        request,
        {
          force: options.shouldBuildLazily && requestedAssetIds.size > 0,
        },
      );

      measurement && measurement.end();
      assertSignalNotAborted(signal);

      // If any subrequests are invalid (e.g. dev dep requests or config requests),
      // bail on incremental bundling. We also need to invalidate for option changes,
      // which are hoisted to direct invalidations on the bundle graph request.
      let subRequestsInvalid =
        Boolean(invalidateReason & OPTION_CHANGE) ||
        input.api
          .getSubRequests()
          .some(req => !input.api.canSkipSubrequest(req.id));

      if (subRequestsInvalid) {
        assetGraph.safeToIncrementallyBundle = false;
      }

      let configResult = nullthrows(
        await input.api.runRequest<null, ConfigAndCachePath>(
          createParcelConfigRequest(),
        ),
      );

      assertSignalNotAborted(signal);

      let parcelConfig = getCachedParcelConfig(configResult, input.options);
      let {devDeps, invalidDevDeps} = await getDevDepRequests(input.api);
      invalidateDevDeps(invalidDevDeps, input.options, parcelConfig);

      let bundlingMeasurement = tracer.createMeasurement('bundling');
      let builder = new BundlerRunner(input, parcelConfig, devDeps);
      let res: BundleGraphResult = await builder.bundle({
        graph: assetGraph,
        changedAssets: changedAssets,
        assetRequests,
      });
      bundlingMeasurement && bundlingMeasurement.end();
      for (let [id, asset] of changedAssets) {
        res.changedAssets.set(id, asset);
      }

      await dumpGraphToGraphViz(
        // $FlowFixMe Added in Flow 0.121.0 upgrade in #4381 (Windows only)
        res.bundleGraph._graph,
        'BundleGraph',
        bundleGraphEdgeTypes,
      );

      return res;
    },
    input,
  };
}

class BundlerRunner {
  options: ParcelOptions;
  optionsRef: SharedReference;
  config: ParcelConfig;
  pluginOptions: PluginOptions;
  api: RunAPI<BundleGraphResult>;
  previousDevDeps: Map<string, string>;
  devDepRequests: Map<string, DevDepRequest>;
  configs: Map<string, Config>;
  cacheKey: string;

  constructor(
    {input, api, options}: RunInput,
    config: ParcelConfig,
    previousDevDeps: Map<string, string>,
  ) {
    this.options = options;
    this.api = api;
    this.optionsRef = input.optionsRef;
    this.config = config;
    this.previousDevDeps = previousDevDeps;
    this.devDepRequests = new Map();
    this.configs = new Map();
    this.pluginOptions = new PluginOptions(
      optionsProxy(this.options, api.invalidateOnOptionChange),
    );
    this.cacheKey =
      hashString(
        `${PARCEL_VERSION}:BundleGraph:${
          JSON.stringify(options.entries) ?? ''
        }${options.mode}${options.shouldBuildLazily ? 'lazy' : 'eager'}`,
      ) + '-BundleGraph';
  }

  async loadConfigs() {
    // Load all configs up front so we can use them in the cache key
    let bundler = await this.config.getBundler();
    await this.loadConfig(bundler);

    let namers = await this.config.getNamers();
    for (let namer of namers) {
      await this.loadConfig(namer);
    }

    let runtimes = await this.config.getRuntimes();
    for (let runtime of runtimes) {
      await this.loadConfig(runtime);
    }
  }

  async loadConfig<T: PluginWithLoadConfig>(plugin: LoadedPlugin<T>) {
    let config = createConfig({
      plugin: plugin.name,
      searchPath: toProjectPathUnsafe('index'),
    });

    await loadPluginConfig(plugin, config, this.options);
    await runConfigRequest(this.api, config);
    for (let devDep of config.devDeps) {
      let devDepRequest = await createDevDependency(
        devDep,
        this.previousDevDeps,
        this.options,
      );
      await this.runDevDepRequest(devDepRequest);
    }

    this.configs.set(plugin.name, config);
  }

  async runDevDepRequest(devDepRequest: DevDepRequest) {
    let {specifier, resolveFrom} = devDepRequest;
    let key = `${specifier}:${fromProjectPathRelative(resolveFrom)}`;
    this.devDepRequests.set(key, devDepRequest);
    await runDevDepRequest(this.api, devDepRequest);
  }

  async bundle({
    graph,
    changedAssets,
    assetRequests,
  }: {|
    graph: AssetGraph,
    changedAssets: Map<string, Asset>,
    assetRequests: Array<AssetGroup>,
  |}): Promise<BundleGraphResult> {
    report({
      type: 'buildProgress',
      phase: 'bundling',
    });

    await this.loadConfigs();

    let plugin = await this.config.getBundler();
    let {plugin: bundler, name, resolveFrom} = plugin;

    // if a previous asset graph hash is passed in, check if the bundle graph is also available
    let previousBundleGraphResult: ?BundleGraphRequestResult;
    if (graph.safeToIncrementallyBundle) {
      try {
        previousBundleGraphResult = await this.api.getPreviousResult();
      } catch {
        // if the bundle graph had an error or was removed, don't fail the build
      }
    }
    if (previousBundleGraphResult == null) {
      graph.safeToIncrementallyBundle = false;
    }

    let internalBundleGraph;

    let logger = new PluginLogger({origin: name});
    let tracer = new PluginTracer({
      origin: name,
      category: 'bundle',
    });
    try {
      if (previousBundleGraphResult) {
        internalBundleGraph = previousBundleGraphResult.bundleGraph;
        for (let changedAssetId of changedAssets.keys()) {
          // Copy over the whole node to also have correct symbol data
          let changedAssetNode = nullthrows(
            graph.getNodeByContentKey(changedAssetId),
          );
          invariant(changedAssetNode.type === 'asset');
          internalBundleGraph.updateAsset(changedAssetNode);
        }
      } else {
        internalBundleGraph = InternalBundleGraph.fromAssetGraph(
          graph,
          this.options.mode === 'production',
        );
        invariant(internalBundleGraph != null); // ensures the graph was created

        await dumpGraphToGraphViz(
          // $FlowFixMe
          internalBundleGraph._graph,
          'before_bundle',
          bundleGraphEdgeTypes,
        );
        let mutableBundleGraph = new MutableBundleGraph(
          internalBundleGraph,
          this.options,
        );

        let measurement;
        let measurementFilename;
        if (tracer.enabled) {
          measurementFilename = graph
            .getEntryAssets()
            .map(asset => fromProjectPathRelative(asset.filePath))
            .join(', ');
          measurement = tracer.createMeasurement(
            plugin.name,
            'bundling:bundle',
            measurementFilename,
          );
        }

        // this the normal bundle workflow (bundle, optimizing, run-times, naming)
        await bundler.bundle({
          bundleGraph: mutableBundleGraph,
          config: this.configs.get(plugin.name)?.result,
          options: this.pluginOptions,
          logger,
          tracer,
        });

        measurement && measurement.end();

        if (this.pluginOptions.mode === 'production') {
          let optimizeMeasurement;
          try {
            if (tracer.enabled) {
              optimizeMeasurement = tracer.createMeasurement(
                plugin.name,
                'bundling:optimize',
                nullthrows(measurementFilename),
              );
            }
            await bundler.optimize({
              bundleGraph: mutableBundleGraph,
              config: this.configs.get(plugin.name)?.result,
              options: this.pluginOptions,
              logger,
            });
          } catch (e) {
            throw new ThrowableDiagnostic({
              diagnostic: errorToDiagnostic(e, {
                origin: plugin.name,
              }),
            });
          } finally {
            optimizeMeasurement && optimizeMeasurement.end();
            await dumpGraphToGraphViz(
              // $FlowFixMe[incompatible-call]
              internalBundleGraph._graph,
              'after_optimize',
            );
          }
        }

        // Add dev dependency for the bundler. This must be done AFTER running it due to
        // the potential for lazy require() that aren't executed until the request runs.
        let devDepRequest = await createDevDependency(
          {
            specifier: name,
            resolveFrom,
          },
          this.previousDevDeps,
          this.options,
        );
        await this.runDevDepRequest(devDepRequest);
      }
    } catch (e) {
      if (internalBundleGraph != null) {
        this.api.storeResult(
          {
            bundleGraph: internalBundleGraph,
            changedAssets: new Map(),
            assetRequests: [],
          },
          this.cacheKey,
        );
      }

      throw new ThrowableDiagnostic({
        diagnostic: errorToDiagnostic(e, {
          origin: name,
        }),
      });
    } finally {
      invariant(internalBundleGraph != null); // ensures the graph was created
      await dumpGraphToGraphViz(
        // $FlowFixMe[incompatible-call]
        internalBundleGraph._graph,
        'after_bundle',
        bundleGraphEdgeTypes,
      );
    }

    let changedRuntimes = new Map();
    if (!previousBundleGraphResult) {
      let namers = await this.config.getNamers();
      // inline bundles must still be named so the PackagerRunner
      // can match them to the correct packager/optimizer plugins.
      let bundles = internalBundleGraph.getBundles({includeInline: true});
      await Promise.all(
        bundles.map(bundle =>
          this.nameBundle(namers, bundle, internalBundleGraph),
        ),
      );

      changedRuntimes = await applyRuntimes({
        bundleGraph: internalBundleGraph,
        api: this.api,
        config: this.config,
        options: this.options,
        optionsRef: this.optionsRef,
        pluginOptions: this.pluginOptions,
        previousDevDeps: this.previousDevDeps,
        devDepRequests: this.devDepRequests,
        configs: this.configs,
      });

      // Add dev deps for namers, AFTER running them to account for lazy require().
      for (let namer of namers) {
        let devDepRequest = await createDevDependency(
          {
            specifier: namer.name,
            resolveFrom: namer.resolveFrom,
          },
          this.previousDevDeps,
          this.options,
        );
        await this.runDevDepRequest(devDepRequest);
      }

      this.validateBundles(internalBundleGraph);

      // Pre-compute the hashes for each bundle so they are only computed once and shared between workers.
      internalBundleGraph.getBundleGraphHash();
    }

    await dumpGraphToGraphViz(
      // $FlowFixMe
      internalBundleGraph._graph,
      'after_runtimes',
      bundleGraphEdgeTypes,
    );

    this.api.storeResult(
      {
        bundleGraph: internalBundleGraph,
        changedAssets: new Map(),
        assetRequests: [],
      },
      this.cacheKey,
    );

    return {
      bundleGraph: internalBundleGraph,
      changedAssets: changedRuntimes,
      assetRequests,
    };
  }

  validateBundles(bundleGraph: InternalBundleGraph): void {
    let bundles = bundleGraph.getBundles();

    let bundleNames = bundles.map(b =>
      joinProjectPath(b.target.distDir, nullthrows(b.name)),
    );
    assert.deepEqual(
      bundleNames,
      unique(bundleNames),
      'Bundles must have unique name. Conflicting names: ' +
        [
          ...setDifference(new Set(bundleNames), new Set(unique(bundleNames))),
        ].join(),
    );
  }

  async nameBundle(
    namers: Array<LoadedPlugin<Namer<mixed>>>,
    internalBundle: InternalBundle,
    internalBundleGraph: InternalBundleGraph,
  ): Promise<void> {
    let bundle = Bundle.get(internalBundle, internalBundleGraph, this.options);
    let bundleGraph = new BundleGraph<IBundle>(
      internalBundleGraph,
      NamedBundle.get.bind(NamedBundle),
      this.options,
    );

    for (let namer of namers) {
      let measurement;
      try {
        measurement = tracer.createMeasurement(namer.name, 'namer', bundle.id);
        let name = await namer.plugin.name({
          bundle,
          bundleGraph,
          config: this.configs.get(namer.name)?.result,
          options: this.pluginOptions,
          logger: new PluginLogger({origin: namer.name}),
          tracer: new PluginTracer({origin: namer.name, category: 'namer'}),
        });

        if (name != null) {
          internalBundle.name = name;
          let {hashReference} = internalBundle;
          internalBundle.displayName = name.includes(hashReference)
            ? name.replace(hashReference, '[hash]')
            : name;

          return;
        }
      } catch (e) {
        throw new ThrowableDiagnostic({
          diagnostic: errorToDiagnostic(e, {
            origin: namer.name,
          }),
        });
      } finally {
        measurement && measurement.end();
      }
    }

    throw new Error('Unable to name bundle');
  }
}
