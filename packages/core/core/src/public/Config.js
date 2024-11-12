// @flow strict-local
import type {
  Config as IConfig,
  ConfigResult,
  FileCreateInvalidation,
  FilePath,
  PackageJSON,
  ConfigResultWithFilePath,
  DevDepOptions,
} from '@parcel/types';
import type {Config, ParcelOptions} from '../types';

import invariant from 'assert';
import path from 'path';
import {
  DefaultWeakMap,
  resolveConfig,
  readConfig,
  relativePath,
} from '@parcel/utils';
import Environment from './Environment';
import {fromProjectPath, toProjectPath} from '../projectPath';

const internalConfigToConfig: DefaultWeakMap<
  ParcelOptions,
  WeakMap<Config, PublicConfig>,
> = new DefaultWeakMap(() => new WeakMap());

export default class PublicConfig implements IConfig {
  #config /*: Config */;
  #pkg /*: ?PackageJSON */;
  #pkgFilePath /*: ?FilePath */;
  #options /*: ParcelOptions */;

  constructor(config: Config, options: ParcelOptions): PublicConfig {
    let existing = internalConfigToConfig.get(options).get(config);
    if (existing != null) {
      return existing;
    }

    this.#config = config;
    this.#options = options;
    internalConfigToConfig.get(options).set(config, this);
    return this;
  }

  get env(): Environment {
    return new Environment(this.#config.env, this.#options);
  }

  get searchPath(): FilePath {
    return fromProjectPath(this.#options.projectRoot, this.#config.searchPath);
  }

  get result(): ConfigResult {
    return this.#config.result;
  }

  get isSource(): boolean {
    return this.#config.isSource;
  }

  // $FlowFixMe
  setResult(result: any): void {
    this.#config.result = result;
  }

  setCacheKey(cacheKey: string) {
    this.#config.cacheKey = cacheKey;
  }

  invalidateOnFileChange(filePath: FilePath) {
    this.#config.invalidateOnFileChange.add(
      toProjectPath(this.#options.projectRoot, filePath),
    );
  }

  invalidateOnConfigKeyChange(filePath: FilePath, configKey: string) {
    this.#config.invalidateOnConfigKeyChange.push({
      filePath: toProjectPath(this.#options.projectRoot, filePath),
      configKey,
    });
  }

  addDevDependency(devDep: DevDepOptions) {
    this.#config.devDeps.push({
      ...devDep,
      resolveFrom: toProjectPath(this.#options.projectRoot, devDep.resolveFrom),
      additionalInvalidations: devDep.additionalInvalidations?.map(i => ({
        ...i,
        resolveFrom: toProjectPath(this.#options.projectRoot, i.resolveFrom),
      })),
    });
  }

  invalidateOnFileCreate(invalidation: FileCreateInvalidation) {
    if (invalidation.glob != null) {
      // $FlowFixMe
      this.#config.invalidateOnFileCreate.push(invalidation);
    } else if (invalidation.filePath != null) {
      this.#config.invalidateOnFileCreate.push({
        filePath: toProjectPath(
          this.#options.projectRoot,
          invalidation.filePath,
        ),
      });
    } else {
      invariant(invalidation.aboveFilePath != null);
      this.#config.invalidateOnFileCreate.push({
        // $FlowFixMe
        fileName: invalidation.fileName,
        aboveFilePath: toProjectPath(
          this.#options.projectRoot,
          invalidation.aboveFilePath,
        ),
      });
    }
  }

  invalidateOnEnvChange(env: string) {
    this.#config.invalidateOnEnvChange.add(env);
  }

  invalidateOnStartup() {
    this.#config.invalidateOnStartup = true;
  }

  invalidateOnBuild() {
    this.#config.invalidateOnBuild = true;
  }

  async getConfigFrom<T>(
    searchPath: FilePath,
    fileNames: Array<string>,
    options: ?{|
      packageKey?: string,
      parse?: boolean,
      exclude?: boolean,
    |},
  ): Promise<?ConfigResultWithFilePath<T>> {
    let packageKey = options?.packageKey;
    if (packageKey != null) {
      let pkg = await this.getConfigFrom(searchPath, ['package.json'], {
        exclude: true,
      });

      if (pkg && pkg.contents[packageKey]) {
        // Invalidate only when the package key changes
        this.invalidateOnConfigKeyChange(pkg.filePath, packageKey);

        return {
          contents: pkg.contents[packageKey],
          filePath: pkg.filePath,
        };
      }
    }

    if (fileNames.length === 0) {
      return null;
    }

    // Invalidate when any of the file names are created above the search path.
    for (let fileName of fileNames) {
      this.invalidateOnFileCreate({
        fileName,
        aboveFilePath: searchPath,
      });
    }

    let parse = options && options.parse;
    let configFilePath = await resolveConfig(
      this.#options.inputFS,
      searchPath,
      fileNames,
      this.#options.projectRoot,
    );
    if (configFilePath == null) {
      return null;
    }

    if (!options || !options.exclude) {
      this.invalidateOnFileChange(configFilePath);
    }

    // If this is a JavaScript file, load it with the package manager.
    let extname = path.extname(configFilePath);
    if (extname === '.js' || extname === '.cjs' || extname === '.mjs') {
      let specifier = relativePath(path.dirname(searchPath), configFilePath);

      // Add dev dependency so we reload the config and any dependencies in watch mode.
      this.addDevDependency({
        specifier,
        resolveFrom: searchPath,
      });

      // Invalidate on startup in case the config is non-deterministic,
      // e.g. uses unknown environment variables, reads from the filesystem, etc.
      this.invalidateOnStartup();

      let config = await this.#options.packageManager.require(
        specifier,
        searchPath,
      );

      if (
        // $FlowFixMe
        Object.prototype.toString.call(config) === '[object Module]' &&
        config.default != null
      ) {
        // Native ESM config. Try to use a default export, otherwise fall back to the whole namespace.
        config = config.default;
      }

      return {
        contents: config,
        filePath: configFilePath,
      };
    }

    let conf = await readConfig(
      this.#options.inputFS,
      configFilePath,
      parse == null ? null : {parse},
    );
    if (conf == null) {
      return null;
    }

    return {
      contents: conf.config,
      filePath: configFilePath,
    };
  }

  getConfig<T>(
    filePaths: Array<FilePath>,
    options: ?{|
      packageKey?: string,
      parse?: boolean,
      exclude?: boolean,
    |},
  ): Promise<?ConfigResultWithFilePath<T>> {
    return this.getConfigFrom(this.searchPath, filePaths, options);
  }

  async getPackage(): Promise<?PackageJSON> {
    if (this.#pkg) {
      return this.#pkg;
    }

    let pkgConfig = await this.getConfig<PackageJSON>(['package.json']);
    if (!pkgConfig) {
      return null;
    }

    this.#pkg = pkgConfig.contents;
    this.#pkgFilePath = pkgConfig.filePath;

    return this.#pkg;
  }
}
