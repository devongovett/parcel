// @flow strict-local
import type {Diagnostic} from '@parcel/diagnostic';
import type {
  Async,
  FileCreateInvalidation,
  FilePath,
  Resolver,
} from '@parcel/types';
import type {StaticRunOpts} from '../RequestTracker';
import type {
  AssetGroup,
  Config,
  Dependency,
  DevDepRequest,
  ParcelOptions,
} from '../types';
import type {ConfigAndCachePath} from './ParcelConfigRequest';

import ThrowableDiagnostic, {
  convertSourceLocationToHighlight,
  errorToDiagnostic,
  md,
} from '@parcel/diagnostic';
import {PluginLogger} from '@parcel/logger';
import nullthrows from 'nullthrows';
import path from 'path';
import {normalizePath} from '@parcel/utils';
import {report} from '../ReporterRunner';
import {getPublicDependency} from '../public/Dependency';
import PluginOptions from '../public/PluginOptions';
import ParcelConfig from '../ParcelConfig';
import createParcelConfigRequest, {
  getCachedParcelConfig,
} from './ParcelConfigRequest';
import {invalidateOnFileCreateToInternal} from '../utils';
import {
  fromProjectPath,
  fromProjectPathRelative,
  toProjectPath,
  toProjectPathUnsafe,
} from '../projectPath';
import {Priority} from '../types';
import {createBuildCache} from '../buildCache';
import type {LoadedPlugin} from '../ParcelConfig';
import {createConfig} from '../InternalConfig';
import {loadPluginConfig, runConfigRequest} from './ConfigRequest';
import {
  createDevDependency,
  getDevDepRequests,
  invalidateDevDeps,
  runDevDepRequest,
} from './DevDepRequest';
import {tracer, PluginTracer} from '@parcel/profiler';
import {requestTypes} from '../RequestTracker';

export type PathRequest = {|
  id: string,
  +type: typeof requestTypes.path_request,
  run: (RunOpts<PathRequestResult>) => Async<PathRequestResult>,
  input: PathRequestInput,
|};

export type PathRequestResult = null | void | AssetGroup;

export type PathRequestInput = {|
  dependency: Dependency,
  name: string,
|};

type RunOpts<TResult> = {|
  input: PathRequestInput,
  ...StaticRunOpts<TResult>,
|};

const PIPELINE_REGEX = /^([a-z0-9-]+?):(.*)$/i;

export default function createPathRequest(
  input: PathRequestInput,
): PathRequest {
  return {
    id: input.dependency.id + ':' + input.name,
    type: requestTypes.path_request,
    run,
    input,
  };
}

async function run({input, api, options}): Promise<PathRequestResult> {
  let configResult = nullthrows(
    await api.runRequest<null, ConfigAndCachePath>(createParcelConfigRequest()),
  );
  let config = getCachedParcelConfig(configResult, options);
  let {devDeps, invalidDevDeps} = await getDevDepRequests(api);
  invalidateDevDeps(invalidDevDeps, options, config);
  let resolverRunner = new ResolverRunner({
    options,
    config,
    previousDevDeps: devDeps,
  });
  let result: ResolverResult = await resolverRunner.resolve(input.dependency);

  if (result.invalidateOnEnvChange) {
    for (let env of result.invalidateOnEnvChange) {
      api.invalidateOnEnvChange(env);
    }
  }

  if (result.invalidateOnFileCreate) {
    for (let file of result.invalidateOnFileCreate) {
      api.invalidateOnFileCreate(
        invalidateOnFileCreateToInternal(options.projectRoot, file),
      );
    }
  }

  if (result.invalidateOnFileChange) {
    for (let filePath of result.invalidateOnFileChange) {
      let pp = toProjectPath(options.projectRoot, filePath);
      api.invalidateOnFileUpdate(pp);
      api.invalidateOnFileDelete(pp);
    }
  }

  for (let config of resolverRunner.configs.values()) {
    await runConfigRequest(api, config);
  }

  for (let devDepRequest of resolverRunner.devDepRequests.values()) {
    await runDevDepRequest(api, devDepRequest);
  }

  if (result.assetGroup) {
    api.invalidateOnFileDelete(result.assetGroup.filePath);
    return result.assetGroup;
  }

  if (result.diagnostics && result.diagnostics.length > 0) {
    let err = new ThrowableDiagnostic({diagnostic: result.diagnostics});
    // $FlowFixMe[prop-missing]
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
}

type ResolverRunnerOpts = {|
  config: ParcelConfig,
  options: ParcelOptions,
  previousDevDeps: Map<string, string>,
|};

type ResolverResult = {|
  assetGroup: ?AssetGroup,
  invalidateOnFileCreate?: Array<FileCreateInvalidation>,
  invalidateOnFileChange?: Array<FilePath>,
  invalidateOnEnvChange?: Array<string>,
  diagnostics?: Array<Diagnostic>,
|};

const configCache = createBuildCache();

export class ResolverRunner {
  config: ParcelConfig;
  options: ParcelOptions;
  pluginOptions: PluginOptions;
  previousDevDeps: Map<string, string>;
  devDepRequests: Map<string, DevDepRequest>;
  configs: Map<string, Config>;

  constructor({config, options, previousDevDeps}: ResolverRunnerOpts) {
    this.config = config;
    this.options = options;
    this.pluginOptions = new PluginOptions(this.options);
    this.previousDevDeps = previousDevDeps;
    this.devDepRequests = new Map();
    this.configs = new Map();
  }

  async getDiagnostic(
    dependency: Dependency,
    message: string,
  ): Async<Diagnostic> {
    let diagnostic: Diagnostic = {
      message,
      origin: '@parcel/core',
    };

    if (dependency.loc && dependency.sourcePath != null) {
      let filePath = fromProjectPath(
        this.options.projectRoot,
        dependency.sourcePath,
      );
      diagnostic.codeFrames = [
        {
          filePath,
          code: await this.options.inputFS
            .readFile(filePath, 'utf8')
            .catch(() => ''),
          codeHighlights: dependency.loc
            ? [convertSourceLocationToHighlight(dependency.loc)]
            : [],
        },
      ];
    }

    return diagnostic;
  }

  async loadConfigs(
    resolvers: Array<LoadedPlugin<Resolver<mixed>>>,
  ): Promise<void> {
    for (let plugin of resolvers) {
      // Only load config for a plugin once per build.
      let config = configCache.get(plugin.name);
      if (!config && plugin.plugin.loadConfig != null) {
        config = createConfig({
          plugin: plugin.name,
          searchPath: toProjectPathUnsafe('index'),
        });

        await loadPluginConfig(plugin, config, this.options);
        configCache.set(plugin.name, config);
        this.configs.set(plugin.name, config);
      }

      if (config) {
        for (let devDep of config.devDeps) {
          let devDepRequest = await createDevDependency(
            devDep,
            this.previousDevDeps,
            this.options,
          );
          this.runDevDepRequest(devDepRequest);
        }

        this.configs.set(plugin.name, config);
      }
    }
  }

  runDevDepRequest(devDepRequest: DevDepRequest) {
    let {specifier, resolveFrom} = devDepRequest;
    let key = `${specifier}:${fromProjectPathRelative(resolveFrom)}`;
    this.devDepRequests.set(key, devDepRequest);
  }

  async resolve(dependency: Dependency): Promise<ResolverResult> {
    let dep = getPublicDependency(dependency, this.options);
    report({
      type: 'buildProgress',
      phase: 'resolving',
      dependency: dep,
    });

    let resolvers = await this.config.getResolvers();
    await this.loadConfigs(resolvers);

    let pipeline;
    let specifier;
    let validPipelines = new Set(this.config.getNamedPipelines());
    let match = dependency.specifier.match(PIPELINE_REGEX);
    if (
      match &&
      // Don't consider absolute paths. Absolute paths are only supported for entries,
      // and include e.g. `C:\` on Windows, conflicting with pipelines.
      !path.isAbsolute(dependency.specifier)
    ) {
      [, pipeline, specifier] = match;
      if (!validPipelines.has(pipeline)) {
        // This may be a url protocol or scheme rather than a pipeline, such as
        // `url('http://example.com/foo.png')`. Pass it to resolvers to handle.
        specifier = dependency.specifier;
        pipeline = null;
      }
    } else {
      specifier = dependency.specifier;
    }

    // Entrypoints, convert ProjectPath in module specifier to absolute path
    if (dep.resolveFrom == null) {
      specifier = path.join(this.options.projectRoot, specifier);
    }
    let diagnostics: Array<Diagnostic> = [];
    let invalidateOnFileCreate = [];
    let invalidateOnFileChange = [];
    let invalidateOnEnvChange = [];
    for (let resolver of resolvers) {
      let measurement;
      try {
        measurement = tracer.createMeasurement(
          resolver.name,
          'resolve',
          specifier,
        );
        let result = await resolver.plugin.resolve({
          specifier,
          pipeline,
          dependency: dep,
          options: this.pluginOptions,
          logger: new PluginLogger({origin: resolver.name}),
          tracer: new PluginTracer({
            origin: resolver.name,
            category: 'resolver',
          }),
          config: this.configs.get(resolver.name)?.result,
        });
        measurement && measurement.end();

        if (result) {
          if (result.meta) {
            dependency.resolverMeta = result.meta;
            dependency.meta = {
              ...dependency.meta,
              ...result.meta,
            };
          }

          if (result.priority != null) {
            dependency.priority = dependency.resolverPriority =
              Priority[result.priority];
          }

          if (result.invalidateOnEnvChange) {
            invalidateOnEnvChange.push(...result.invalidateOnEnvChange);
          }

          if (result.invalidateOnFileCreate) {
            invalidateOnFileCreate.push(...result.invalidateOnFileCreate);
          }

          if (result.invalidateOnFileChange) {
            invalidateOnFileChange.push(...result.invalidateOnFileChange);
          }

          if (result.isExcluded) {
            return {
              assetGroup: null,
              invalidateOnFileCreate,
              invalidateOnFileChange,
              invalidateOnEnvChange,
            };
          }

          if (result.filePath != null) {
            let resultFilePath = result.filePath;
            if (!path.isAbsolute(resultFilePath)) {
              throw new Error(
                md`Resolvers must return an absolute path, ${resolver.name} returned: ${resultFilePath}`,
              );
            }

            return {
              assetGroup: {
                canDefer: result.canDefer,
                filePath: toProjectPath(
                  this.options.projectRoot,
                  resultFilePath,
                ),
                query: result.query?.toString(),
                sideEffects: result.sideEffects,
                code: result.code,
                env: dependency.env,
                pipeline:
                  result.pipeline === undefined
                    ? pipeline ?? dependency.pipeline
                    : result.pipeline,
                isURL: dep.specifierType === 'url',
              },
              invalidateOnFileCreate,
              invalidateOnFileChange,
              invalidateOnEnvChange,
            };
          }

          if (
            result.diagnostics != null &&
            !(
              Array.isArray(result.diagnostics) &&
              result.diagnostics.length === 0
            )
          ) {
            let errorDiagnostic = errorToDiagnostic(
              new ThrowableDiagnostic({diagnostic: result.diagnostics}),
              {
                origin: resolver.name,
                filePath: specifier,
              },
            );
            diagnostics.push(...errorDiagnostic);
          }
        }
      } catch (e) {
        // Add error to error map, we'll append these to the standard error if we can't resolve the asset
        let errorDiagnostic = errorToDiagnostic(e, {
          origin: resolver.name,
          filePath: specifier,
        });
        if (Array.isArray(errorDiagnostic)) {
          diagnostics.push(...errorDiagnostic);
        } else {
          diagnostics.push(errorDiagnostic);
        }

        break;
      } finally {
        measurement && measurement.end();

        // Add dev dependency for the resolver. This must be done AFTER running it due to
        // the potential for lazy require() that aren't executed until the request runs.
        let devDepRequest = await createDevDependency(
          {
            specifier: resolver.name,
            resolveFrom: resolver.resolveFrom,
          },
          this.previousDevDeps,
          this.options,
        );
        this.runDevDepRequest(devDepRequest);
      }
    }

    if (dep.isOptional) {
      return {
        assetGroup: null,
        invalidateOnFileCreate,
        invalidateOnFileChange,
        invalidateOnEnvChange,
      };
    }

    let resolveFrom = dependency.resolveFrom ?? dependency.sourcePath;
    let dir =
      resolveFrom != null
        ? normalizePath(fromProjectPathRelative(resolveFrom))
        : '';

    let diagnostic = await this.getDiagnostic(
      dependency,
      md`Failed to resolve '${dependency.specifier}' ${
        dir ? `from '${dir}'` : ''
      }`,
    );

    diagnostics.unshift(diagnostic);

    return {
      assetGroup: null,
      invalidateOnFileCreate,
      invalidateOnFileChange,
      invalidateOnEnvChange,
      diagnostics,
    };
  }
}
