// @flow strict-local

import type {
  MutableAsset as IMutableAsset,
  FilePath,
  GenerateOutput,
  Transformer,
  TransformerResult,
  PackageName
} from '@parcel/types';
import type {
  Asset as AssetValue,
  AssetRequest,
  Config,
  NodeId,
  ConfigRequest,
  ParcelOptions
} from './types';
import type {WorkerApi} from '@parcel/workers';

import invariant from 'assert';
import path from 'path';
import nullthrows from 'nullthrows';
import {md5FromObject} from '@parcel/utils';

import {createDependency} from './Dependency';
import {localRequireFromWorker} from '@parcel/local-require';

import ResolverRunner from './ResolverRunner';
import {report} from './ReporterRunner';
import {MutableAsset, assetToInternalAsset} from './public/Asset';
import InternalAsset, {createAsset} from './InternalAsset';
import ParcelConfig from './ParcelConfig';
import summarizeRequest from './summarizeRequest';
import PluginOptions from './public/PluginOptions';

type GenerateFunc = (input: IMutableAsset) => Promise<GenerateOutput>;

type PostProcessFunc = (
  Array<InternalAsset>
) => Promise<Array<InternalAsset> | null>;

export type TransformationOpts = {|
  request: AssetRequest,
  loadConfig: (ConfigRequest, NodeId) => Promise<Config>,
  parentNodeId: NodeId,
  options: ParcelOptions,
  workerApi: WorkerApi
|};

type ConfigMap = Map<PackageName, Config>;

export default class Transformation {
  request: AssetRequest;
  configRequests: Array<ConfigRequest>;
  loadConfig: ConfigRequest => Promise<Config>;
  options: ParcelOptions;
  impactfulOptions: $Shape<ParcelOptions>;
  workerApi: WorkerApi;

  constructor({
    request,
    loadConfig,
    parentNodeId,
    options,
    workerApi
  }: TransformationOpts) {
    this.request = request;
    this.configRequests = [];
    this.loadConfig = configRequest => {
      this.configRequests.push(configRequest);
      return loadConfig(configRequest, parentNodeId);
    };
    this.options = options;
    this.workerApi = workerApi;

    // TODO: these options may not impact all transformations, let transformers decide if they care or not
    let {minify, hot, scopeHoist} = this.options;
    this.impactfulOptions = {minify, hot, scopeHoist};
  }

  async run(): Promise<{
    assets: Array<AssetValue>,
    configRequests: Array<ConfigRequest>
  }> {
    report({
      type: 'buildProgress',
      phase: 'transforming',
      filePath: this.request.filePath
    });

    let asset = await this.loadAsset();
    let pipeline = await this.loadPipeline(this.request.filePath);
    let results = await this.runPipeline(pipeline, asset);
    let assets = results.map(a => a.value);

    return {assets, configRequests: this.configRequests};
  }

  async loadAsset(): Promise<InternalAsset> {
    let {filePath, env, code, sideEffects} = this.request;
    let {content, size, hash} = await summarizeRequest(
      this.options.inputFS,
      this.request
    );

    // If the transformer request passed code rather than a filename,
    // use a hash as the base for the id to ensure it is unique.
    let idBase = code != null ? hash : filePath;
    return new InternalAsset({
      idBase,
      value: createAsset({
        idBase,
        filePath,
        type: path.extname(filePath).slice(1),
        hash,
        env,
        stats: {
          time: 0,
          size
        },
        sideEffects
      }),
      options: this.options,
      content
    });
  }

  async runPipeline(
    pipeline: Pipeline,
    initialAsset: InternalAsset
  ): Promise<Array<InternalAsset>> {
    let initialType = initialAsset.value.type;
    // TODO: is this reading/writing from the cache every time we jump a pipeline? Seems possibly unnecessary...
    let initialCacheEntry = await this.readFromCache(
      [initialAsset],
      pipeline.configs
    );

    let assets = initialCacheEntry || (await pipeline.transform(initialAsset));
    if (!initialCacheEntry) {
      await this.writeToCache(assets, pipeline.configs);
    }

    let finalAssets: Array<InternalAsset> = [];
    for (let asset of assets) {
      let nextPipeline;
      if (asset.value.type !== initialType) {
        nextPipeline = await this.loadNextPipeline(
          initialAsset.value.filePath,
          asset.value.type,
          pipeline
        );
      }

      if (nextPipeline) {
        let nextPipelineAssets = await this.runPipeline(nextPipeline, asset);
        finalAssets = finalAssets.concat(nextPipelineAssets);
      } else {
        finalAssets.push(asset);
      }
    }

    if (!pipeline.postProcess) {
      return finalAssets;
    }

    let processedCacheEntry = await this.readFromCache(
      finalAssets,
      pipeline.configs
    );

    invariant(pipeline.postProcess != null);
    let processedFinalAssets: Array<InternalAsset> =
      processedCacheEntry ?? (await pipeline.postProcess(assets)) ?? [];

    if (!processedCacheEntry) {
      await this.writeToCache(processedFinalAssets, pipeline.configs);
    }

    return processedFinalAssets;
  }

  async readFromCache(
    assets: Array<InternalAsset>,
    configs: ConfigMap
  ): Promise<null | Array<InternalAsset>> {
    if (this.options.disableCache || this.request.code != null) {
      return null;
    }

    let cacheKey = await this.getCacheKey(assets, configs);
    let cachedAssets = await this.options.cache.get(cacheKey);
    if (!cachedAssets) {
      return null;
    }

    return cachedAssets.map(
      (value: AssetValue) =>
        new InternalAsset({
          value,
          options: this.options
        })
    );
  }

  async writeToCache(
    assets: Array<InternalAsset>,
    configs: ConfigMap
  ): Promise<void> {
    let cacheKey = await this.getCacheKey(assets, configs);
    await Promise.all(
      // TODO: account for impactfulOptions maybe being different per pipeline
      assets.map(asset => asset.commit(md5FromObject(this.impactfulOptions)))
    );
    this.options.cache.set(cacheKey, assets.map(a => a.value));
  }

  async getCacheKey(
    assets: Array<InternalAsset>,
    configs: ConfigMap
  ): Promise<string> {
    let assetsKeyInfo = assets.map(a => ({
      filePath: a.value.filePath,
      hash: a.value.hash,
      type: a.value.type
    }));

    let configsKeyInfo = [...configs].map(([, {resultHash, devDeps}]) => ({
      resultHash,
      devDeps: [...devDeps]
    }));

    return md5FromObject({
      assets: assetsKeyInfo,
      configs: configsKeyInfo,
      env: this.request.env,
      impactfulOptions: this.impactfulOptions
    });
  }

  async loadPipeline(filePath: FilePath): Promise<Pipeline> {
    let configRequest = {
      filePath,
      meta: {
        actionType: 'transformation'
      }
    };
    let configs = new Map();

    let config = await this.loadConfig(configRequest);
    let result = nullthrows(config.result);
    let parcelConfig = new ParcelConfig(result);

    configs.set('parcel', config);

    for (let [moduleName] of config.devDeps) {
      let plugin = await parcelConfig.loadPlugin(moduleName);
      // TODO: implement loadPlugin in existing plugins that require config
      if (plugin.loadConfig) {
        let thirdPartyConfig = await this.loadTransformerConfig(
          filePath,
          moduleName,
          result.resolvedPath
        );
        configs.set(moduleName, thirdPartyConfig);
      }
    }

    let pipeline = new Pipeline({
      id: parcelConfig.getTransformerNames(filePath).join(':'),
      transformers: await parcelConfig.getTransformers(filePath),
      configs,
      options: this.options,
      workerApi: this.workerApi
    });

    return pipeline;
  }

  async loadNextPipeline(
    filePath: string,
    nextType: string,
    currentPipeline: Pipeline
  ): Promise<?Pipeline> {
    let nextFilePath =
      filePath.slice(0, -path.extname(filePath).length) + '.' + nextType;
    let nextPipeline = await this.loadPipeline(nextFilePath);

    if (nextPipeline.id === currentPipeline.id) {
      return null;
    }

    return nextPipeline;
  }

  async loadTransformerConfig(
    filePath: FilePath,
    plugin: PackageName,
    parcelConfigPath: FilePath
  ): Promise<Config> {
    let configRequest = {
      filePath,
      plugin,
      meta: {
        parcelConfigPath
      }
    };
    return this.loadConfig(configRequest);
  }
}

type PipelineOpts = {|
  id: string,
  transformers: Array<Transformer>,
  configs: ConfigMap,
  options: ParcelOptions,
  workerApi: WorkerApi
|};

class Pipeline {
  id: string;
  transformers: Array<Transformer>;
  configs: ConfigMap;
  options: ParcelOptions;
  pluginOptions: PluginOptions;
  resolverRunner: ResolverRunner;
  generate: GenerateFunc;
  postProcess: ?PostProcessFunc;
  workerApi: WorkerApi;

  constructor({id, transformers, configs, options, workerApi}: PipelineOpts) {
    this.id = id;
    this.transformers = transformers;
    this.configs = configs;
    this.options = options;
    let parcelConfig = nullthrows(this.configs.get('parcel'));
    parcelConfig = nullthrows(parcelConfig.result);
    this.resolverRunner = new ResolverRunner({
      config: parcelConfig,
      options
    });

    this.pluginOptions = new PluginOptions(this.options);
    this.workerApi = workerApi;
  }

  async transform(initialAsset: InternalAsset): Promise<Array<InternalAsset>> {
    let initialType = initialAsset.value.type;
    let inputAssets = [initialAsset];
    let resultingAssets;
    let finalAssets = [];
    for (let transformer of this.transformers) {
      resultingAssets = [];
      for (let asset of inputAssets) {
        // TODO: I think there may be a bug here if the type changes but does not
        // change pipelines (e.g. .html -> .htm). It should continue on the same
        // pipeline in that case.
        if (asset.value.type !== initialType) {
          finalAssets.push(asset);
        } else {
          let transformerResults = await this.runTransformer(
            asset,
            transformer
          );
          for (let result of transformerResults) {
            resultingAssets.push(asset.createChildAsset(result));
          }
        }
      }
      inputAssets = resultingAssets;
    }

    finalAssets = finalAssets.concat(resultingAssets);

    return Promise.all(
      finalAssets.map(asset => finalize(nullthrows(asset), this.generate))
    );
  }

  async runTransformer(
    asset: InternalAsset,
    transformer: Transformer
  ): Promise<Array<TransformerResult>> {
    const resolve = async (from: FilePath, to: string): Promise<FilePath> => {
      return (await this.resolverRunner.resolve(
        createDependency({
          env: asset.value.env,
          moduleSpecifier: to,
          sourcePath: from
        })
      )).filePath;
    };

    let localRequire = localRequireFromWorker.bind(null, this.workerApi);

    // Load config for the transformer.
    let config = null;
    if (transformer.getConfig) {
      config = await transformer.getConfig({
        asset: new MutableAsset(asset),
        options: this.pluginOptions,
        resolve,
        localRequire
      });
    }

    // If an ast exists on the asset, but we cannot reuse it,
    // use the previous transform to generate code that we can re-parse.
    if (
      asset.ast &&
      (!transformer.canReuseAST ||
        !transformer.canReuseAST({
          ast: asset.ast,
          options: this.pluginOptions
        })) &&
      this.generate
    ) {
      let output = await this.generate(new MutableAsset(asset));
      asset.content = output.code;
      asset.ast = null;
    }

    // Parse if there is no AST available from a previous transform.
    if (!asset.ast && transformer.parse) {
      asset.ast = await transformer.parse({
        asset: new MutableAsset(asset),
        config,
        options: this.pluginOptions,
        resolve
      });
    }

    // Transform.
    let results = await normalizeAssets(
      // $FlowFixMe
      await transformer.transform({
        asset: new MutableAsset(asset),
        config,
        options: this.pluginOptions,
        localRequire,
        resolve
      })
    );

    // Create generate and postProcess functions that can be called later
    this.generate = async (input: IMutableAsset): Promise<GenerateOutput> => {
      if (transformer.generate) {
        return transformer.generate({
          asset: input,
          config,
          options: this.pluginOptions,
          resolve
        });
      }

      throw new Error(
        'Asset has an AST but no generate method is available on the transform'
      );
    };

    // For Flow
    let postProcess = transformer.postProcess;
    if (postProcess) {
      this.postProcess = async (
        assets: Array<InternalAsset>
      ): Promise<Array<InternalAsset> | null> => {
        let results = await postProcess.call(transformer, {
          assets: assets.map(asset => new MutableAsset(asset)),
          config,
          options: this.pluginOptions,
          resolve
        });

        return Promise.all(
          results.map(result => asset.createChildAsset(result))
        );
      };
    }

    return results;
  }
}

async function finalize(
  asset: InternalAsset,
  generate: GenerateFunc
): Promise<InternalAsset> {
  if (asset.ast && generate) {
    let result = await generate(new MutableAsset(asset));
    asset.content = result.code;
    asset.map = result.map;
  }
  return asset;
}

function normalizeAssets(
  results: Array<TransformerResult | MutableAsset>
): Array<TransformerResult> {
  return results.map(result => {
    if (!(result instanceof MutableAsset)) {
      return result;
    }

    let internalAsset = assetToInternalAsset(result);
    return {
      type: result.type,
      content: internalAsset.content,
      ast: result.ast,
      map: internalAsset.map,
      // $FlowFixMe
      dependencies: [...internalAsset.value.dependencies.values()],
      connectedFiles: result.getConnectedFiles(),
      // $FlowFixMe
      env: result.env,
      isIsolated: result.isIsolated,
      meta: result.meta
    };
  });
}
