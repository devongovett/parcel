// @flow
import type {FileSystem} from './types';
import type {FilePath} from '@parcel/types';
import type {
  Event,
  Options as WatcherOptions,
  AsyncSubscription
} from '@parcel/watcher';

import {registerSerializableClass} from '@parcel/utils';
import packageJSON from '../package.json';

function read(method) {
  return async function(...args: Array<any>) {
    try {
      return await this.writable[method](...args);
    } catch (err) {
      return this.readable[method](...args);
    }
  };
}

function readSync(method) {
  return function(...args: Array<any>) {
    try {
      return this.writable[method](...args);
    } catch (err) {
      return this.readable[method](...args);
    }
  };
}

function write(method) {
  return function(...args: Array<any>) {
    return this.writable[method](...args);
  };
}

function checkExists(method) {
  return function(filePath: FilePath, ...args: Array<any>) {
    if (this.writable.existsSync(filePath)) {
      return this.writable[method](filePath, ...args);
    }

    return this.readable[method](filePath, ...args);
  };
}

export class OverlayFS implements FileSystem {
  writable: FileSystem;
  readable: FileSystem;
  constructor(writable: FileSystem, readable: FileSystem) {
    this.writable = writable;
    this.readable = readable;
  }

  static deserialize(opts: any) {
    return new OverlayFS(opts.writable, opts.readable);
  }

  serialize() {
    return {
      $$raw: false,
      writable: this.writable,
      readable: this.readable
    };
  }

  readFile = read('readFile');
  writeFile = write('writeFile');
  copyFile = write('copyFile');
  stat = read('stat');
  unlink = write('unlink');
  mkdirp = write('mkdirp');
  rimraf = write('rimraf');
  ncp = write('ncp');
  createReadStream = checkExists('createReadStream');
  createWriteStream = write('createWriteStream');
  cwd = readSync('cwd');
  chdir = readSync('chdir');
  realpath = checkExists('realpath');
  exists = read('exists');

  readFileSync = readSync('readFileSync');
  statSync = readSync('statSync');
  existsSync = readSync('existsSync');
  realpathSync = checkExists('realpathSync');

  async readdir(path: FilePath): Promise<FilePath[]> {
    // Read from both filesystems and merge the results
    let writable = [];
    let readable = [];
    try {
      writable = await this.writable.readdir(path);
    } catch (err) {
      // do nothing
    }

    try {
      readable = await this.readable.readdir(path);
    } catch (err) {
      // do nothing
    }

    return Array.from(new Set([...writable, ...readable]));
  }

  async watch(
    dir: FilePath,
    fn: (err: ?Error, events: Array<Event>) => mixed,
    opts: WatcherOptions
  ): Promise<AsyncSubscription> {
    let writableSubscription = await this.writable.watch(dir, fn, opts);
    let readableSubscription = await this.readable.watch(dir, fn, opts);
    return {
      unsubscribe: async () => {
        await writableSubscription.unsubscribe();
        await readableSubscription.unsubscribe();
      }
    };
  }

  async getEventsSince(
    dir: FilePath,
    snapshot: FilePath,
    opts: WatcherOptions
  ): Promise<Array<Event>> {
    let writableEvents = await this.writable.getEventsSince(
      dir,
      snapshot,
      opts
    );
    let readableEvents = await this.readable.getEventsSince(
      dir,
      snapshot,
      opts
    );
    return [...writableEvents, ...readableEvents];
  }

  async writeSnapshot(
    dir: FilePath,
    snapshot: FilePath,
    opts: WatcherOptions
  ): Promise<void> {
    await this.writable.writeSnapshot(dir, snapshot, opts);
  }
}

registerSerializableClass(`${packageJSON.version}:OverlayFS`, OverlayFS);
