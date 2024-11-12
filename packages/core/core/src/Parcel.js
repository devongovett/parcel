// @flow strict-local

import type {
  Asset,
  AsyncSubscription,
  BuildEvent,
  BuildSuccessEvent,
  InitialParcelOptions,
  PackagedBundle as IPackagedBundle,
  ParcelTransformOptions,
  ParcelResolveOptions,
  ParcelResolveResult,
} from '@parcel/types';
import path from 'path';
import type {ParcelOptions} from './types';
// eslint-disable-next-line no-unused-vars
import type {FarmOptions, SharedReference} from '@parcel/workers';
import type {Diagnostic} from '@parcel/diagnostic';

import invariant from 'assert';
import ThrowableDiagnostic, {anyToDiagnostic} from '@parcel/diagnostic';
import {assetFromValue} from './public/Asset';
import {PackagedBundle} from './public/Bundle';
import BundleGraph from './public/BundleGraph';
import WorkerFarm from '@parcel/workers';
import nullthrows from 'nullthrows';
import {BuildAbortError} from './utils';
import {loadParcelConfig} from './requests/ParcelConfigRequest';
import ReporterRunner from './ReporterRunner';
import dumpGraphToGraphViz from './dumpGraphToGraphViz';
import resolveOptions from './resolveOptions';
import {ValueEmitter} from '@parcel/events';
import {registerCoreWithSerializer} from './registerCoreWithSerializer';
import {PromiseQueue} from '@parcel/utils';
import ParcelConfig from './ParcelConfig';
import logger from '@parcel/logger';
import RequestTracker, {
  getWatcherOptions,
  requestGraphEdgeTypes,
} from './RequestTracker';
import createValidationRequest from './requests/ValidationRequest';
import createParcelBuildRequest from './requests/ParcelBuildRequest';
import createAssetRequest from './requests/AssetRequest';
import createPathRequest from './requests/PathRequest';
import {createEnvironment} from './Environment';
import {createDependency} from './Dependency';
import {Disposable} from '@parcel/events';
import {init as initSourcemaps} from '@parcel/source-map';
import {init as initRust} from '@parcel/rust';
import {
  fromProjectPath,
  toProjectPath,
  fromProjectPathRelative,
} from './projectPath';
import {tracer} from '@parcel/profiler';
import {setFeatureFlags} from '@parcel/feature-flags';

registerCoreWithSerializer();

export const INTERNAL_TRANSFORM: symbol = Symbol('internal_transform');
export const INTERNAL_RESOLVE: symbol = Symbol('internal_resolve');

export default class Parcel {
  #requestTracker /*: RequestTracker*/;
  #config /*: ParcelConfig*/;
  #farm /*: WorkerFarm*/;
  #initialized /*: boolean*/ = false;
  #disposable /*: Disposable */;
  #initialOptions /*: InitialParcelOptions */;
  #reporterRunner /*: ReporterRunner*/;
  #resolvedOptions /*: ?ParcelOptions*/ = null;
  #optionsRef /*: SharedReference */;
  #watchAbortController /*: AbortController*/;
  #watchQueue /*: PromiseQueue<?BuildEvent>*/ = new PromiseQueue<?BuildEvent>({
    maxConcurrent: 1,
  });
  #watchEvents /*: ValueEmitter<
    | {|
        +error: Error,
        +buildEvent?: void,
      |}
    | {|
        +buildEvent: BuildEvent,
        +error?: void,
      |},
  > */;
  #watcherSubscription /*: ?AsyncSubscription*/;
  #watcherCount /*: number*/ = 0;
  #requestedAssetIds /*: Set<string>*/ = new Set();

  isProfiling /*: boolean */;

  constructor(options: InitialParcelOptions) {
    this.#initialOptions = options;
  }

  async _init(): Promise<void> {
    if (this.#initialized) {
      return;
    }

    await initSourcemaps;
    await initRust?.();

    let resolvedOptions: ParcelOptions = await resolveOptions(
      this.#initialOptions,
    );
    this.#resolvedOptions = resolvedOptions;

    let {config} = await loadParcelConfig(resolvedOptions);
    this.#config = new ParcelConfig(config, resolvedOptions);

    setFeatureFlags(resolvedOptions.featureFlags);

    if (this.#initialOptions.workerFarm) {
      if (this.#initialOptions.workerFarm.ending) {
        throw new Error('Supplied WorkerFarm is ending');
      }
      this.#farm = this.#initialOptions.workerFarm;
    } else {
      this.#farm = createWorkerFarm({
        shouldPatchConsole: resolvedOptions.shouldPatchConsole,
        shouldTrace: resolvedOptions.shouldTrace,
      });
    }

    await resolvedOptions.cache.ensure();

    let {dispose: disposeOptions, ref: optionsRef} =
      await this.#farm.createSharedReference(resolvedOptions, false);
    this.#optionsRef = optionsRef;

    this.#disposable = new Disposable();
    if (this.#initialOptions.workerFarm) {
      // If we don't own the farm, dispose of only these references when
      // Parcel ends.
      this.#disposable.add(disposeOptions);
    } else {
      // Otherwise, when shutting down, end the entire farm we created.
      this.#disposable.add(() => this.#farm.end());
    }

    this.#watchEvents = new ValueEmitter();
    this.#disposable.add(() => this.#watchEvents.dispose());

    this.#reporterRunner = new ReporterRunner({
      options: resolvedOptions,
      reporters: await this.#config.getReporters(),
      workerFarm: this.#farm,
    });
    this.#disposable.add(this.#reporterRunner);

    logger.verbose({
      origin: '@parcel/core',
      message: 'Intializing request tracker...',
    });

    this.#requestTracker = await RequestTracker.init({
      farm: this.#farm,
      options: resolvedOptions,
    });

    this.#initialized = true;
  }

  async run(): Promise<BuildSuccessEvent> {
    let startTime = Date.now();
    if (!this.#initialized) {
      await this._init();
    }

    let result = await this._build({startTime});

    await this._end();

    if (result.type === 'buildFailure') {
      throw new BuildError(result.diagnostics);
    }

    return result;
  }

  async _end(): Promise<void> {
    this.#initialized = false;

    await this.#requestTracker.writeToCache();
    await this.#disposable.dispose();
  }

  async _startNextBuild(): Promise<?BuildEvent> {
    this.#watchAbortController = new AbortController();
    await this.#farm.callAllWorkers('clearConfigCache', []);

    try {
      let buildEvent = await this._build({
        signal: this.#watchAbortController.signal,
      });

      this.#watchEvents.emit({
        buildEvent,
      });

      return buildEvent;
    } catch (err) {
      // Ignore BuildAbortErrors and only emit critical errors.
      if (!(err instanceof BuildAbortError)) {
        throw err;
      }
    }
  }

  async watch(
    cb?: (err: ?Error, buildEvent?: BuildEvent) => mixed,
  ): Promise<AsyncSubscription> {
    if (!this.#initialized) {
      await this._init();
    }

    let watchEventsDisposable;
    if (cb) {
      watchEventsDisposable = this.#watchEvents.addListener(
        ({error, buildEvent}) => cb(error, buildEvent),
      );
    }

    if (this.#watcherCount === 0) {
      this.#watcherSubscription = await this._getWatcherSubscription();
      await this.#reporterRunner.report({type: 'watchStart'});

      // Kick off a first build, but don't await its results. Its results will
      // be provided to the callback.
      this.#watchQueue.add(() => this._startNextBuild());
      this.#watchQueue.run();
    }

    this.#watcherCount++;

    let unsubscribePromise;
    const unsubscribe = async () => {
      if (watchEventsDisposable) {
        watchEventsDisposable.dispose();
      }

      this.#watcherCount--;
      if (this.#watcherCount === 0) {
        await nullthrows(this.#watcherSubscription).unsubscribe();
        this.#watcherSubscription = null;
        await this.#reporterRunner.report({type: 'watchEnd'});
        this.#watchAbortController.abort();
        await this.#watchQueue.run();
        await this._end();
      }
    };

    return {
      unsubscribe() {
        if (unsubscribePromise == null) {
          unsubscribePromise = unsubscribe();
        }

        return unsubscribePromise;
      },
    };
  }

  async _build({
    signal,
    startTime = Date.now(),
  }: {|
    signal?: AbortSignal,
    startTime?: number,
  |} = {
    /*::...null*/
  }): Promise<BuildEvent> {
    this.#requestTracker.setSignal(signal);
    let options = nullthrows(this.#resolvedOptions);
    try {
      if (options.shouldProfile) {
        await this.startProfiling();
      }
      if (options.shouldTrace) {
        tracer.enable();
      }
      await this.#reporterRunner.report({
        type: 'buildStart',
      });

      this.#requestTracker.graph.invalidateOnBuildNodes();

      let request = createParcelBuildRequest({
        optionsRef: this.#optionsRef,
        requestedAssetIds: this.#requestedAssetIds,
        signal,
      });

      let {bundleGraph, bundleInfo, changedAssets, assetRequests} =
        await this.#requestTracker.runRequest(request, {force: true});

      this.#requestedAssetIds.clear();

      await dumpGraphToGraphViz(
        // $FlowFixMe
        this.#requestTracker.graph,
        'RequestGraph',
        requestGraphEdgeTypes,
      );

      let event = {
        type: 'buildSuccess',
        changedAssets: new Map(
          Array.from(changedAssets).map(([id, asset]) => [
            id,
            assetFromValue(asset, options),
          ]),
        ),
        bundleGraph: new BundleGraph<IPackagedBundle>(
          bundleGraph,
          (bundle, bundleGraph, options) =>
            PackagedBundle.getWithInfo(
              bundle,
              bundleGraph,
              options,
              bundleInfo.get(bundle.id),
            ),
          options,
        ),
        buildTime: Date.now() - startTime,
        requestBundle: async bundle => {
          let bundleNode = bundleGraph._graph.getNodeByContentKey(bundle.id);
          invariant(bundleNode?.type === 'bundle', 'Bundle does not exist');

          if (!bundleNode.value.isPlaceholder) {
            // Nothing to do.
            return {
              type: 'buildSuccess',
              changedAssets: new Map(),
              bundleGraph: event.bundleGraph,
              buildTime: 0,
              requestBundle: event.requestBundle,
              unstable_requestStats: {},
            };
          }

          for (let assetId of bundleNode.value.entryAssetIds) {
            this.#requestedAssetIds.add(assetId);
          }

          if (this.#watchQueue.getNumWaiting() === 0) {
            if (this.#watchAbortController) {
              this.#watchAbortController.abort();
            }

            this.#watchQueue.add(() => this._startNextBuild());
          }

          let results = await this.#watchQueue.run();
          let result = results.filter(Boolean).pop();
          if (result.type === 'buildFailure') {
            throw new BuildError(result.diagnostics);
          }

          return result;
        },
        unstable_requestStats: this.#requestTracker.flushStats(),
      };

      await this.#reporterRunner.report(event);
      await this.#requestTracker.runRequest(
        createValidationRequest({optionsRef: this.#optionsRef, assetRequests}),
        {force: assetRequests.length > 0},
      );

      if (this.#reporterRunner.errors.length) {
        throw this.#reporterRunner.errors;
      }

      return event;
    } catch (e) {
      if (e instanceof BuildAbortError) {
        throw e;
      }

      let diagnostic = anyToDiagnostic(e);
      let event = {
        type: 'buildFailure',
        diagnostics: Array.isArray(diagnostic) ? diagnostic : [diagnostic],
        unstable_requestStats: this.#requestTracker.flushStats(),
      };

      await this.#reporterRunner.report(event);
      return event;
    } finally {
      if (this.isProfiling) {
        await this.stopProfiling();
      }

      await this.#farm.callAllWorkers('clearConfigCache', []);
    }
  }

  async _getWatcherSubscription(): Promise<AsyncSubscription> {
    invariant(this.#watcherSubscription == null);

    let resolvedOptions = nullthrows(this.#resolvedOptions);
    let opts = getWatcherOptions(resolvedOptions);
    let sub = await resolvedOptions.inputFS.watch(
      resolvedOptions.watchDir,
      async (err, events) => {
        if (err) {
          logger.verbose({
            message: `File watch event error occured`,
            meta: {err},
          });
          this.#watchEvents.emit({error: err});
          return;
        }

        logger.verbose({
          message: `File watch event emitted with ${events.length} events. Sample event: [${events[0]?.type}] ${events[0]?.path}`,
        });

        let isInvalid = await this.#requestTracker.respondToFSEvents(
          events,
          Number.POSITIVE_INFINITY,
        );
        if (isInvalid && this.#watchQueue.getNumWaiting() === 0) {
          if (this.#watchAbortController) {
            this.#watchAbortController.abort();
          }

          this.#watchQueue.add(() => this._startNextBuild());
          this.#watchQueue.run();
        }
      },
      opts,
    );
    return {unsubscribe: () => sub.unsubscribe()};
  }

  // This is mainly for integration tests and it not public api!
  _getResolvedParcelOptions(): ParcelOptions {
    return nullthrows(
      this.#resolvedOptions,
      'Resolved options is null, please let parcel initialize before accessing this.',
    );
  }

  async startProfiling(): Promise<void> {
    if (this.isProfiling) {
      throw new Error('Parcel is already profiling');
    }

    logger.info({origin: '@parcel/core', message: 'Starting profiling...'});
    this.isProfiling = true;
    await this.#farm.startProfile();
  }

  stopProfiling(): Promise<void> {
    if (!this.isProfiling) {
      throw new Error('Parcel is not profiling');
    }

    logger.info({origin: '@parcel/core', message: 'Stopping profiling...'});
    this.isProfiling = false;
    return this.#farm.endProfile();
  }

  takeHeapSnapshot(): Promise<void> {
    logger.info({origin: '@parcel/core', message: 'Taking heap snapshot...'});
    return this.#farm.takeHeapSnapshot();
  }

  async unstable_transform(
    options: ParcelTransformOptions,
  ): Promise<Array<Asset>> {
    if (!this.#initialized) {
      await this._init();
    }

    let projectRoot = nullthrows(this.#resolvedOptions).projectRoot;
    let request = createAssetRequest({
      ...options,
      filePath: toProjectPath(projectRoot, options.filePath),
      optionsRef: this.#optionsRef,
      env: createEnvironment({
        ...options.env,
        loc:
          options.env?.loc != null
            ? {
                ...options.env.loc,
                filePath: toProjectPath(projectRoot, options.env.loc.filePath),
              }
            : undefined,
      }),
    });

    let res = await this.#requestTracker.runRequest(request, {
      force: true,
    });
    return res.map(asset =>
      assetFromValue(asset, nullthrows(this.#resolvedOptions)),
    );
  }

  async unstable_resolve(
    request: ParcelResolveOptions,
  ): Promise<?ParcelResolveResult> {
    if (!this.#initialized) {
      await this._init();
    }

    let projectRoot = nullthrows(this.#resolvedOptions).projectRoot;
    if (request.resolveFrom == null && path.isAbsolute(request.specifier)) {
      request.specifier = fromProjectPathRelative(
        toProjectPath(projectRoot, request.specifier),
      );
    }

    let dependency = createDependency(projectRoot, {
      ...request,
      env: createEnvironment({
        ...request.env,
        loc:
          request.env?.loc != null
            ? {
                ...request.env.loc,
                filePath: toProjectPath(projectRoot, request.env.loc.filePath),
              }
            : undefined,
      }),
    });

    let req = createPathRequest({
      dependency,
      name: request.specifier,
    });

    let res = await this.#requestTracker.runRequest(req, {
      force: true,
    });
    if (!res) {
      return null;
    }

    return {
      filePath: fromProjectPath(projectRoot, res.filePath),
      code: res.code,
      query: res.query,
      sideEffects: res.sideEffects,
    };
  }
}

export class BuildError extends ThrowableDiagnostic {
  constructor(diagnostic: Array<Diagnostic> | Diagnostic) {
    super({diagnostic});
    this.name = 'BuildError';
  }
}

export function createWorkerFarm(
  options: $Shape<FarmOptions> = {},
): WorkerFarm {
  return new WorkerFarm({
    ...options,
    // $FlowFixMe
    workerPath: process.browser
      ? '@parcel/core/src/worker.js'
      : require.resolve('./worker'),
  });
}
