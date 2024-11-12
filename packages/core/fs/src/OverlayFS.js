// @flow

import type {Readable, Writable} from 'stream';
import type {
  FilePath,
  Encoding,
  FileOptions,
  FileSystem,
  ReaddirOptions,
  FileStats,
} from '@parcel/types-internal';
import type {
  Event,
  Options as WatcherOptions,
  AsyncSubscription,
} from '@parcel/watcher';

import {registerSerializableClass} from '@parcel/core';
import WorkerFarm from '@parcel/workers';
import packageJSON from '../package.json';
import {findAncestorFile, findNodeModule, findFirstFile} from './find';
import {MemoryFS} from './MemoryFS';

import nullthrows from 'nullthrows';
import path from 'path';

export class OverlayFS implements FileSystem {
  deleted: Set<FilePath> = new Set();
  writable: FileSystem;
  readable: FileSystem;
  _cwd: FilePath;

  constructor(workerFarmOrFS: WorkerFarm | FileSystem, readable: FileSystem) {
    if (workerFarmOrFS instanceof WorkerFarm) {
      this.writable = new MemoryFS(workerFarmOrFS);
    } else {
      this.writable = workerFarmOrFS;
    }
    this.readable = readable;
    this._cwd = readable.cwd();
  }

  static deserialize(opts: any): OverlayFS {
    let fs = new OverlayFS(opts.writable, opts.readable);
    if (opts.deleted != null) fs.deleted = opts.deleted;
    return fs;
  }

  serialize(): {|
    $$raw: boolean,
    readable: FileSystem,
    writable: FileSystem,
    deleted: Set<FilePath>,
  |} {
    return {
      $$raw: false,
      writable: this.writable,
      readable: this.readable,
      deleted: this.deleted,
    };
  }

  _deletedThrows(filePath: FilePath): FilePath {
    filePath = this._normalizePath(filePath);
    if (this.deleted.has(filePath)) {
      throw new FSError('ENOENT', filePath, 'does not exist');
    }
    return filePath;
  }

  _checkExists(filePath: FilePath): FilePath {
    filePath = this._deletedThrows(filePath);
    if (!this.existsSync(filePath)) {
      throw new FSError('ENOENT', filePath, 'does not exist');
    }
    return filePath;
  }

  _isSymlink(filePath: FilePath): boolean {
    filePath = this._normalizePath(filePath);
    // Check the parts of the path to see if any are symlinks.
    let {root, dir, base} = path.parse(filePath);
    let segments = dir.slice(root.length).split(path.sep).concat(base);
    while (segments.length) {
      filePath = path.join(root, ...segments);
      let name = segments.pop();
      if (this.deleted.has(filePath)) {
        return false;
      } else if (
        this.writable instanceof MemoryFS &&
        this.writable.symlinks.has(filePath)
      ) {
        return true;
      } else {
        // HACK: Parcel fs does not provide `lstatSync`,
        // so we use `readdirSync` to check if the path is a symlink.
        let parent = path.resolve(filePath, '..');
        if (parent === filePath) {
          return false;
        }
        try {
          for (let dirent of this.readdirSync(parent, {withFileTypes: true})) {
            if (typeof dirent === 'string') {
              break; // {withFileTypes: true} not supported
            } else if (dirent.name === name) {
              if (dirent.isSymbolicLink()) {
                return true;
              }
            }
          }
        } catch (e) {
          if (e.code === 'ENOENT') {
            return false;
          }
          throw e;
        }
      }
    }

    return false;
  }

  async _copyPathForWrite(filePath: FilePath): Promise<FilePath> {
    filePath = await this._normalizePath(filePath);
    let dirPath = path.dirname(filePath);
    if (this.existsSync(dirPath) && !this.writable.existsSync(dirPath)) {
      await this.writable.mkdirp(dirPath);
    }
    return filePath;
  }

  _normalizePath(filePath: FilePath): FilePath {
    return path.resolve(this.cwd(), filePath);
  }

  // eslint-disable-next-line require-await
  async readFile(filePath: FilePath, encoding?: Encoding): Promise<any> {
    return this.readFileSync(filePath, encoding);
  }

  async writeFile(
    filePath: FilePath,
    contents: string | Buffer,
    options: ?FileOptions,
  ): Promise<void> {
    filePath = await this._copyPathForWrite(filePath);
    await this.writable.writeFile(filePath, contents, options);
    this.deleted.delete(filePath);
  }

  async copyFile(source: FilePath, destination: FilePath): Promise<void> {
    source = this._normalizePath(source);
    destination = await this._copyPathForWrite(destination);

    if (await this.writable.exists(source)) {
      await this.writable.writeFile(
        destination,
        await this.writable.readFile(source),
      );
    } else {
      await this.writable.writeFile(
        destination,
        await this.readable.readFile(source),
      );
    }

    this.deleted.delete(destination);
  }

  // eslint-disable-next-line require-await
  async stat(filePath: FilePath): Promise<FileStats> {
    return this.statSync(filePath);
  }

  // eslint-disable-next-line require-await
  async lstat(filePath: FilePath): Promise<FileStats> {
    return this.lstatSync(filePath);
  }

  async symlink(target: FilePath, filePath: FilePath): Promise<void> {
    target = this._normalizePath(target);
    filePath = this._normalizePath(filePath);
    await this.writable.symlink(target, filePath);
    this.deleted.delete(filePath);
  }

  async unlink(filePath: FilePath): Promise<void> {
    filePath = this._normalizePath(filePath);

    let toDelete = [filePath];

    if (this.writable instanceof MemoryFS && this._isSymlink(filePath)) {
      this.writable.symlinks.delete(filePath);
    } else if (this.statSync(filePath).isDirectory()) {
      let stack = [filePath];

      // Recursively add every descendant path to deleted.
      while (stack.length) {
        let root = nullthrows(stack.pop());
        for (let ent of this.readdirSync(root, {withFileTypes: true})) {
          if (typeof ent === 'string') {
            let childPath = path.join(root, ent);
            toDelete.push(childPath);
            if (this.statSync(childPath).isDirectory()) {
              stack.push(childPath);
            }
          } else {
            let childPath = path.join(root, ent.name);
            toDelete.push(childPath);
            if (ent.isDirectory()) {
              stack.push(childPath);
            }
          }
        }
      }
    }

    try {
      await this.writable.unlink(filePath);
    } catch (e) {
      if (e.code === 'ENOENT' && !this.readable.existsSync(filePath)) {
        throw e;
      }
    }

    for (let pathToDelete of toDelete) {
      this.deleted.add(pathToDelete);
    }
  }

  async mkdirp(dir: FilePath): Promise<void> {
    dir = this._normalizePath(dir);
    await this.writable.mkdirp(dir);

    if (this.deleted != null) {
      let root = path.parse(dir).root;
      while (dir !== root) {
        this.deleted.delete(dir);
        dir = path.dirname(dir);
      }
    }
  }

  async rimraf(filePath: FilePath): Promise<void> {
    try {
      await this.unlink(filePath);
    } catch (e) {
      // noop
    }
  }

  // eslint-disable-next-line require-await
  async ncp(source: FilePath, destination: FilePath): Promise<void> {
    // TODO: Implement this correctly.
    return this.writable.ncp(source, destination);
  }

  createReadStream(filePath: FilePath, opts?: ?FileOptions): Readable {
    filePath = this._deletedThrows(filePath);
    if (this.writable.existsSync(filePath)) {
      return this.writable.createReadStream(filePath, opts);
    }

    return this.readable.createReadStream(filePath, opts);
  }

  createWriteStream(path: FilePath, opts?: ?FileOptions): Writable {
    path = this._normalizePath(path);
    this.deleted.delete(path);
    return this.writable.createWriteStream(path, opts);
  }

  cwd(): FilePath {
    return this._cwd;
  }

  chdir(path: FilePath): void {
    this._cwd = this._checkExists(path);
  }

  // eslint-disable-next-line require-await
  async realpath(filePath: FilePath): Promise<FilePath> {
    return this.realpathSync(filePath);
  }

  readFileSync(filePath: FilePath, encoding?: Encoding): any {
    filePath = this.realpathSync(filePath);
    try {
      // $FlowFixMe[incompatible-call]
      return this.writable.readFileSync(filePath, encoding);
    } catch (err) {
      // $FlowFixMe[incompatible-call]
      return this.readable.readFileSync(filePath, encoding);
    }
  }

  statSync(filePath: FilePath): FileStats {
    filePath = this._normalizePath(filePath);
    try {
      return this.writable.statSync(filePath);
    } catch (e) {
      if (e.code === 'ENOENT' && this.existsSync(filePath)) {
        return this.readable.statSync(filePath);
      }
      throw e;
    }
  }

  lstatSync(filePath: FilePath): FileStats {
    filePath = this._normalizePath(filePath);
    try {
      return this.writable.lstatSync(filePath);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return this.readable.lstatSync(filePath);
      }
      throw e;
    }
  }

  realpathSync(filePath: FilePath): FilePath {
    filePath = this._deletedThrows(filePath);
    filePath = this._deletedThrows(this.writable.realpathSync(filePath));
    if (!this.writable.existsSync(filePath)) {
      return this.readable.realpathSync(filePath);
    }
    return filePath;
  }

  readlinkSync(filePath: FilePath): FilePath {
    filePath = this._deletedThrows(filePath);
    try {
      return this.writable.readlinkSync(filePath);
    } catch (err) {
      return this.readable.readlinkSync(filePath);
    }
  }

  // eslint-disable-next-line require-await
  async readlink(filePath: FilePath): Promise<FilePath> {
    return this.readlinkSync(filePath);
  }

  // eslint-disable-next-line require-await
  async exists(filePath: FilePath): Promise<boolean> {
    return this.existsSync(filePath);
  }

  existsSync(filePath: FilePath): boolean {
    filePath = this._normalizePath(filePath);
    if (this.deleted.has(filePath)) return false;

    try {
      filePath = this.realpathSync(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    if (this.deleted.has(filePath)) return false;

    return (
      this.writable.existsSync(filePath) || this.readable.existsSync(filePath)
    );
  }

  // eslint-disable-next-line require-await
  async readdir(path: FilePath, opts?: ReaddirOptions): Promise<any> {
    return this.readdirSync(path, opts);
  }

  readdirSync(dir: FilePath, opts?: ReaddirOptions): any {
    dir = this.realpathSync(dir);
    // Read from both filesystems and merge the results
    let entries = new Map();

    try {
      for (let entry: any of this.writable.readdirSync(dir, opts)) {
        let filePath = path.join(dir, entry.name ?? entry);
        if (this.deleted.has(filePath)) continue;
        entries.set(filePath, entry);
      }
    } catch {
      // noop
    }

    try {
      for (let entry: any of this.readable.readdirSync(dir, opts)) {
        let filePath = path.join(dir, entry.name ?? entry);
        if (this.deleted.has(filePath)) continue;
        if (entries.has(filePath)) continue;
        entries.set(filePath, entry);
      }
    } catch {
      // noop
    }

    return Array.from(entries.values());
  }

  async watch(
    dir: FilePath,
    fn: (err: ?Error, events: Array<Event>) => mixed,
    opts: WatcherOptions,
  ): Promise<AsyncSubscription> {
    let writableSubscription = await this.writable.watch(dir, fn, opts);
    let readableSubscription = await this.readable.watch(dir, fn, opts);
    return {
      unsubscribe: async () => {
        await writableSubscription.unsubscribe();
        await readableSubscription.unsubscribe();
      },
    };
  }

  async getEventsSince(
    dir: FilePath,
    snapshot: FilePath,
    opts: WatcherOptions,
  ): Promise<Array<Event>> {
    let writableEvents = await this.writable.getEventsSince(
      dir,
      snapshot,
      opts,
    );
    let readableEvents = await this.readable.getEventsSince(
      dir,
      snapshot,
      opts,
    );
    return [...writableEvents, ...readableEvents];
  }

  async writeSnapshot(
    dir: FilePath,
    snapshot: FilePath,
    opts: WatcherOptions,
  ): Promise<void> {
    await this.writable.writeSnapshot(dir, snapshot, opts);
  }

  findAncestorFile(
    fileNames: Array<string>,
    fromDir: FilePath,
    root: FilePath,
  ): ?FilePath {
    return findAncestorFile(this, fileNames, fromDir, root);
  }

  findNodeModule(moduleName: string, fromDir: FilePath): ?FilePath {
    return findNodeModule(this, moduleName, fromDir);
  }

  findFirstFile(filePaths: Array<FilePath>): ?FilePath {
    return findFirstFile(this, filePaths);
  }
}

class FSError extends Error {
  code: string;
  path: FilePath;
  constructor(code: string, path: FilePath, message: string) {
    super(`${code}: ${path} ${message}`);
    this.name = 'FSError';
    this.code = code;
    this.path = path;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

registerSerializableClass(`${packageJSON.version}:OverlayFS`, OverlayFS);
