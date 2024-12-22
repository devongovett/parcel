// @flow
import type {PluginLogger, BundleGraph, PackagedBundle} from '@parcel/types';

import {md, errorToDiagnostic} from '@parcel/diagnostic';
import nullthrows from 'nullthrows';
import {Worker} from 'worker_threads';
import path from 'path';

export type NodeRunnerOptions = {|
  hmr: boolean,
  logger: PluginLogger,
|};

export class NodeRunner {
  worker: Worker | null = null;
  bundleGraph: BundleGraph<PackagedBundle> | null = null;
  pending: boolean = true;
  logger: PluginLogger;
  hmr: boolean;

  constructor(options: NodeRunnerOptions) {
    this.logger = options.logger;
    this.hmr = options.hmr;
  }

  buildStart() {
    this.pending = true;
  }

  buildSuccess(bundleGraph: BundleGraph<PackagedBundle>) {
    this.bundleGraph = bundleGraph;
    this.pending = false;
    if (this.worker == null) {
      this.startWorker();
    } else if (!this.hmr) {
      this.restartWorker();
    }
  }

  startWorker() {
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

      worker.on('message', msg => {
        if (msg === 'restart') {
          this.restartWorker();
        }
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
      this.startWorker();
    }
  }
}
