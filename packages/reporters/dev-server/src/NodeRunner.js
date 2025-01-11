// @flow
import type {PluginLogger, BundleGraph, PackagedBundle} from '@parcel/types';

import {md, errorToDiagnostic} from '@parcel/diagnostic';
import nullthrows from 'nullthrows';
import {Worker} from 'worker_threads';
import path from 'path';
import {type Deferred, makeDeferredWithPromise} from '@parcel/utils';
import type {HMRMessage} from './HMRServer';

export type NodeRunnerOptions = {|
  hmr: boolean,
  logger: PluginLogger,
|};

export class NodeRunner {
  worker: Worker | null = null;
  bundleGraph: BundleGraph<PackagedBundle> | null = null;
  pending: Promise<void> | null = null;
  deferred: Deferred<void> | null = null;
  logger: PluginLogger;
  hmr: boolean;

  constructor(options: NodeRunnerOptions) {
    this.logger = options.logger;
    this.hmr = options.hmr;
  }

  buildStart() {
    let {deferred, promise} = makeDeferredWithPromise();
    this.pending = promise;
    this.deferred = deferred;
  }

  async buildSuccess(bundleGraph: BundleGraph<PackagedBundle>) {
    this.bundleGraph = bundleGraph;

    let deferred = this.deferred;
    this.pending = null;
    this.deferred = null;

    if (this.worker == null) {
      await this.startWorker();
    } else if (!this.hmr) {
      await this.restartWorker();
    }

    deferred?.resolve();
  }

  startWorker(): Promise<void> {
    let entry = nullthrows(this.bundleGraph)
      .getEntryBundles()
      .find(b => b.env.isNode() && b.type === 'js');
    if (entry) {
      let relativePath = path.relative(process.cwd(), entry.filePath);
      this.logger.log({message: md`Starting __${relativePath}__...`});
      let worker = new Worker(entry.filePath, {
        execArgv: ['--enable-source-maps'],
        workerData: {
          // Used by the hmr-runtime to detect when to send restart messages.
          __parcel: true,
        },
        stdout: true,
        stderr: true,
      });

      worker.on('error', (err: Error) => {
        this.logger.error(errorToDiagnostic(err));
      });

      worker.stderr.setEncoding('utf8');
      worker.stderr.on('data', data => {
        for (let line of data.split('\n')) {
          this.logger.error({
            origin: relativePath,
            message: line,
            skipFormatting: true,
          });
        }
      });

      worker.stdout.setEncoding('utf8');
      worker.stdout.on('data', data => {
        for (let line of data.split('\n')) {
          this.logger.log({
            origin: relativePath,
            message: line,
            skipFormatting: true,
          });
        }
      });

      worker.on('exit', () => {
        this.worker = null;
      });

      this.worker = worker;

      return new Promise(resolve => {
        if (this.hmr) {
          worker.once('message', () => resolve());
        } else {
          worker.once('online', () => resolve());
        }
      });
    } else {
      return Promise.resolve();
    }
  }

  async stop(): Promise<void> {
    await this.worker?.terminate();
    this.worker = null;
  }

  async restartWorker(): Promise<void> {
    await this.stop();

    // HMR updates are sent before packaging is complete.
    // If the build is still pending, wait until it completes to restart.
    if (!this.pending) {
      await this.startWorker();
    } else {
      await this.pending;
    }
  }

  emitUpdate(update: HMRMessage): Promise<void> {
    if (update.type === 'reload') {
      return this.restartWorker();
    }

    return new Promise((resolve, reject) => {
      let worker = this.worker;
      if (worker) {
        worker.once('message', msg => {
          if (msg === 'restart') {
            this.restartWorker().then(resolve, reject);
          } else {
            resolve();
          }
        });

        worker.postMessage(update);
      } else {
        resolve();
      }
    });
  }
}
