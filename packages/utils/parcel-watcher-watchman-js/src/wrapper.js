// @flow
import * as fs from 'fs';
import * as path from 'path';
import * as watchman from 'fb-watchman';
import {isGlob} from '@parcel/utils';
import logger from '@parcel/logger';
import type {
  Options,
  Event,
  SubscribeCallback,
  AsyncSubscription,
} from '@parcel/watcher';

type WatchmanArgs = any;
type FilePath = string;
type GlobPattern = string;

// Matches the Watcher API from "@parcel/watcher"
export interface Watcher {
  getEventsSince(
    dir: FilePath,
    snapshot: FilePath,
    opts?: Options,
  ): Promise<Array<Event>>;
  subscribe(
    dir: FilePath,
    fn: SubscribeCallback,
    opts?: Options,
  ): Promise<AsyncSubscription>;
  unsubscribe(
    dir: FilePath,
    fn: SubscribeCallback,
    opts?: Options,
  ): Promise<void>;
  writeSnapshot(
    dir: FilePath,
    snapshot: FilePath,
    opts?: Options,
  ): Promise<FilePath>;
}

export class ParcelWatcherWatchmanJS implements Watcher {
  subscriptionName: string;
  client: watchman.Client;
  initPromise: Promise<void> | void;

  constructor() {
    this.subscriptionName = 'parcel-watcher-subscription-' + Date.now();
    this.client = new watchman.Client();
  }

  commandAsync(args: any[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = this.client;
      client.command(
        args,
        // $FlowFixMe
        (err: Error | null | undefined, response: any) => {
          if (err) reject(err);
          else resolve(response);
        },
      );
    });
  }

  capabilityCheckAsync(args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const client = this.client;
      client.capabilityCheck(
        args,
        // $FlowFixMe
        (err: Error | null | undefined, response: any) => {
          if (err) reject(err);
          else resolve(response);
        },
      );
    });
  }
  async _init(watchDir: string): Promise<void> {
    await this.capabilityCheckAsync({optional: [], required: []});
    const resp = await this.commandAsync(['watch-project', watchDir]);

    if ('warning' in resp) {
      logger.warn({message: resp.warning});
    }
  }

  init(watchDir: string): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init(watchDir);

    return this.initPromise;
  }

  // Types should match @parcel/watcher/index.js.flow
  async writeSnapshot(dir: string, snapshot: FilePath): Promise<string> {
    await this.init(dir);

    const response = await this.commandAsync(['clock', dir]);
    fs.writeFileSync(snapshot, response.clock, {
      encoding: 'utf-8',
    });
    return response.clock;
  }

  async getEventsSince(
    dir: string,
    snapshot: FilePath,
    opts?: Options,
  ): Promise<Event[]> {
    await this.init(dir);

    const clock = fs.readFileSync(snapshot, {
      encoding: 'utf-8',
    });

    const response = await this.commandAsync([
      'query',
      dir,
      {
        expression: this._createExpression(dir, opts?.ignore),
        fields: ['name', 'mode', 'exists', 'new'],
        since: clock,
      },
    ]);

    return (response.files || []).map((file: any) => ({
      path: file.name,
      type: file.new ? 'create' : file.exists ? 'update' : 'delete',
    }));
  }

  _createExpression(
    dir: string,
    ignore?: Array<FilePath | GlobPattern>,
  ): WatchmanArgs {
    const ignores = [
      // Ignore the watchman cookie
      ['match', '.watchman-cookie-*'],
      // Ignore directory changes as they are just noise
      ['type', 'd'],
    ];

    if (ignore) {
      const customIgnores = ignore?.map(filePathOrGlob => {
        const relative = path.relative(dir, filePathOrGlob);

        if (isGlob(filePathOrGlob)) {
          return ['match', relative, 'wholename'];
        }

        // If pattern is not a glob, then assume it's a directory.
        // Ignoring single files is not currently supported
        return ['dirname', relative];
      });

      ignores.push(...customIgnores);
    }

    return ['not', ['anyof', ...ignores]];
  }

  async subscribe(
    dir: string,
    fn: SubscribeCallback,
    opts?: Options,
  ): Promise<AsyncSubscription> {
    await this.init(dir);

    const {subscriptionName} = this;
    const {clock} = await this.commandAsync(['clock', dir]);

    await this.commandAsync([
      'subscribe',
      dir,
      subscriptionName,
      {
        // `defer` can be used here if you want to pause the
        // notification stream until something has finished.
        //
        // https://facebook.github.io/watchman/docs/cmd/subscribe#defer
        // defer: ['my-company-example'],
        expression: this._createExpression(dir, opts?.ignore),
        fields: ['name', 'mode', 'exists', 'new'],
        since: clock,
      },
    ]);

    this.client.on('subscription', function (resp) {
      if (!resp.files || resp.subscription !== subscriptionName) {
        return;
      }

      fn(
        null /* err */,
        resp.files.map((file: any) => {
          return {
            path: path.join(dir, file.name),
            type: file.new ? 'create' : file.exists ? 'update' : 'delete',
          };
        }),
      );
    });

    const unsubscribe = async () => {
      await this.commandAsync(['unsubscribe', dir, subscriptionName]);
    };

    return {
      unsubscribe,
    };
  }

  async unsubscribe(dir: string): Promise<void> {
    await this.commandAsync(['unsubscribe', dir, this.subscriptionName]);
  }
}
