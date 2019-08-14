// @flow strict-local
// flowlint unsafe-getters-setters:off
import type {
  Config as IConfig,
  FilePath,
  Glob,
  PackageJSON,
  PackageName,
  Config as ThirdPartyConfig
} from '@parcel/types';
import type {Config, ParcelOptions} from '../types';

import path from 'path';
import {loadConfig} from '@parcel/utils';

const NODE_MODULES = `${path.sep}node_modules${path.sep}`;

export default class PublicConfig implements IConfig {
  #config; // Config;
  #options; // ParcelOptions

  constructor(config: Config, options: ParcelOptions) {
    this.#config = config;
    this.#options = options;
  }

  get searchPath() {
    return this.#config.searchPath;
  }

  get result() {
    return this.#config.result;
  }

  setResolvedPath(filePath: FilePath) {
    this.#config.resolvedPath = filePath;
  }

  // $FlowFixMe
  setResult(result: any) {
    this.#config.result = result;
  }

  setResultHash(resultHash: string) {
    this.#config.resultHash = resultHash;
  }

  addIncludedFile(filePath: FilePath) {
    this.#config.includedFiles.add(filePath);
  }

  addDevDependency(name: PackageName, version?: string) {
    this.#config.devDeps.set(name, version);
  }

  setWatchGlob(glob: Glob) {
    this.#config.watchGlob = glob;
  }

  shouldRehydrate() {
    this.#config.shouldRehydrate = true;
  }

  shouldReload() {
    this.#config.shouldReload = true;
  }

  shouldInvalidateOnStartup() {
    this.#config.shouldInvalidateOnStartup = true;
  }

  async getConfigFrom(
    searchPath: FilePath,
    filePaths: Array<FilePath>,
    options: ?{parse?: boolean, exclude?: boolean}
  ): Promise<ThirdPartyConfig | null> {
    let parse = options && options.parse;
    let conf = await loadConfig(
      this.#options.inputFS,
      searchPath,
      filePaths,
      parse == null ? null : {parse}
    );
    if (conf == null) {
      return null;
    }

    if (!options || !options.exclude) {
      for (let file of conf.files) {
        this.addIncludedFile(file.filePath);
      }
    }

    return conf.config;
  }

  async getConfig(
    filePaths: Array<FilePath>,
    options: ?{parse?: boolean, exclude?: boolean}
  ): Promise<ThirdPartyConfig | null> {
    return this.getConfigFrom(this.searchPath, filePaths, options);
  }

  async getPackage(): Promise<PackageJSON | null> {
    if (this.#config.pkg) {
      return this.#config.pkg;
    }

    this.#config.pkg = await this.getConfig(['package.json']);
    return this.#config.pkg;
  }

  async isSource() {
    let pkg = await this.getPackage();
    return (
      !!(
        pkg &&
        pkg.source != null &&
        (await this.#options.inputFS.realpath(this.searchPath)) !==
          this.searchPath
      ) || !this.#config.searchPath.includes(NODE_MODULES)
    );
  }
}
