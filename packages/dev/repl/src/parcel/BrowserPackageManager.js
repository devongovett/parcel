// @flow
import type {FilePath, DependencySpecifier, SemverRange} from '@parcel/types';
import type {FileSystem} from '@parcel/fs';
import type {
  PackageManager,
  Invalidations,
  ResolveResult,
} from '@parcel/package-manager';
import {registerSerializableClass} from '@parcel/core';
// $FlowFixMe[untyped-import]
import packageJson from '../../package.json';

import path from 'path';
import nullthrows from 'nullthrows';
import {ResolverBase, init} from '@parcel/node-resolver-core';

import bundlerDefault from '@parcel/bundler-default';
import compressorRaw from '@parcel/compressor-raw';
import namerDefault from '@parcel/namer-default';
import optimizerCSS from '@parcel/optimizer-css';
import optimizerTerser from '@parcel/optimizer-terser';
import packagerCss from '@parcel/packager-css';
import packagerHtml from '@parcel/packager-html';
import packagerJs from '@parcel/packager-js';
import packagerRaw from '@parcel/packager-raw';
import reporterJson from '@parcel/reporter-json';
import reporterServer from '@parcel/reporter-dev-server-sw';
import resolverDefault from '@parcel/resolver-default';
import resolverREPLRuntimes from '@parcel/resolver-repl-runtimes';
import runtimeHMR from '@parcel/runtime-browser-hmr';
import runtimeJs from '@parcel/runtime-js';
import runtimeReactRefresh from '@parcel/runtime-react-refresh';
import transformerBabel from '@parcel/transformer-babel';
import transformerCss from '@parcel/transformer-css';
import transformerHtml from '@parcel/transformer-html';
import transformerInlineString from '@parcel/transformer-inline-string';
import transformerJs from '@parcel/transformer-js';
import transformerJson from '@parcel/transformer-json';
import transformerPostcss from '@parcel/transformer-postcss';
import transformerPosthtml from '@parcel/transformer-posthtml';
import transformerRaw from '@parcel/transformer-raw';
import transformerReactRefreshWrap from '@parcel/transformer-react-refresh-wrap';

export const BUILTINS = {
  '@parcel/bundler-default': bundlerDefault,
  '@parcel/compressor-raw': compressorRaw,
  '@parcel/namer-default': namerDefault,
  '@parcel/optimizer-css': optimizerCSS,
  '@parcel/optimizer-terser': optimizerTerser,
  '@parcel/packager-css': packagerCss,
  '@parcel/packager-html': packagerHtml,
  '@parcel/packager-js': packagerJs,
  '@parcel/packager-raw': packagerRaw,
  '@parcel/reporter-dev-server-sw': reporterServer,
  '@parcel/reporter-json': reporterJson,
  '@parcel/resolver-default': resolverDefault,
  '@parcel/resolver-repl-runtimes': resolverREPLRuntimes,
  '@parcel/runtime-browser-hmr': runtimeHMR,
  '@parcel/runtime-js': runtimeJs,
  '@parcel/runtime-react-refresh': runtimeReactRefresh,
  '@parcel/transformer-babel': transformerBabel,
  '@parcel/transformer-css': transformerCss,
  '@parcel/transformer-html': transformerHtml,
  '@parcel/transformer-inline-string': transformerInlineString,
  '@parcel/transformer-js': transformerJs,
  '@parcel/transformer-json': transformerJson,
  '@parcel/transformer-postcss': transformerPostcss,
  '@parcel/transformer-posthtml': transformerPosthtml,
  '@parcel/transformer-raw': transformerRaw,
  '@parcel/transformer-react-refresh-wrap': transformerReactRefreshWrap,
};

// Package.json fields. Must match package_json.rs.
const MAIN = 1 << 0;
const SOURCE = 1 << 2;
const ENTRIES =
  MAIN |
  (process.env.PARCEL_BUILD_ENV !== 'production' ||
  process.env.PARCEL_SELF_BUILD
    ? SOURCE
    : 0);

const IS_FILE = 1 << 0;
const IS_DIR = 1 << 1;
const IS_SYMLINK = 1 << 2;

export class BrowserPackageManager implements PackageManager {
  resolver: ?ResolverBase;
  fs: FileSystem;
  projectRoot: FilePath;
  cache: Map<DependencySpecifier, ResolveResult> = new Map();

  constructor(fs: FileSystem, projectRoot: FilePath) {
    this.fs = fs;
    this.projectRoot = projectRoot;
  }

  async getResolver(): Promise<ResolverBase> {
    if (this.resolver != null) return this.resolver;
    await init?.();
    this.resolver = new ResolverBase(this.projectRoot, {
      fs: {
        read: path => this.fs.readFileSync(path),
        kind: path => {
          let flags = 0;
          try {
            let stat = this.fs.lstatSync(path);
            if (stat.isSymbolicLink()) {
              flags |= IS_SYMLINK;
              stat = this.fs.statSync(path);
            }
            if (stat.isFile()) {
              flags |= IS_FILE;
            } else if (stat.isDirectory()) {
              flags |= IS_DIR;
            }
          } catch (err) {
            // ignore
          }
          return flags;
        },
        readLink: path => this.fs.readlinkSync(path),
      },
      mode: 2,
      entries: ENTRIES,
      packageExports: true,
    });
    return this.resolver;
  }

  static deserialize(opts: any): BrowserPackageManager {
    return new BrowserPackageManager(opts.fs, opts.projectRoot);
  }

  serialize(): {|
    $$raw: boolean,
    fs: FileSystem,
    projectRoot: FilePath,
  |} {
    return {
      $$raw: false,
      fs: this.fs,
      projectRoot: this.projectRoot,
    };
  }

  async require(
    name: DependencySpecifier,
    from: FilePath,
    opts: ?{|
      range?: ?SemverRange,
      shouldAutoInstall?: boolean,
      saveDev?: boolean,
    |},
  ): Promise<any> {
    let {resolved} = await this.resolve(name, from, opts);

    // $FlowFixMe
    if (resolved in BUILTINS) {
      return BUILTINS[resolved];
    }

    throw new Error(`Cannot require '${resolved}' in the browser`);
  }

  async resolve(
    name: DependencySpecifier,
    from: FilePath,
    // eslint-disable-next-line no-unused-vars
    options?: ?{|
      range?: ?SemverRange,
      shouldAutoInstall?: boolean,
      saveDev?: boolean,
    |},
  ): Promise<ResolveResult> {
    if (name.startsWith('@parcel/') && name !== '@parcel/watcher') {
      return Promise.resolve({
        resolved: name,
        pkg: {
          name: name,
          version: '2.0.0',
          engines: {
            parcel: '^2.0.0',
          },
        },
        invalidateOnFileChange: new Set(),
        invalidateOnFileCreate: [],
        type: 1,
      });
    }

    let basedir = path.dirname(from);
    let key = basedir + ':' + name;
    let resolved = this.cache.get(key);
    if (!resolved) {
      let res = (await this.getResolver()).resolve({
        filename: name,
        specifierType: 'commonjs',
        parent: from,
      });
      if (res.error) {
        let e = new Error(`Could not resolve module "${name}" from "${from}"`);
        // $FlowFixMe
        e.code = 'MODULE_NOT_FOUND';
        throw e;
      }
      let getPkg;
      switch (res.resolution.type) {
        case 'Path':
          getPkg = () => {
            let pkgPath = this.fs.findAncestorFile(
              ['package.json'],
              nullthrows(res.resolution.value),
              this.projectRoot,
            );
            resolved = pkgPath
              ? JSON.parse(this.fs.readFileSync(pkgPath, 'utf8'))
              : null;
          };
        // fallthrough
        case 'Builtin':
          resolved = {
            resolved: res.resolution.value,
            invalidateOnFileChange: new Set(res.invalidateOnFileChange),
            invalidateOnFileCreate: res.invalidateOnFileCreate,
            type: res.moduleType,
            get pkg() {
              return getPkg();
            },
          };
          break;
        default:
          throw new Error('Unknown resolution type');
      }
      this.cache.set(key, resolved);
    }
    return nullthrows(resolved);
  }

  getInvalidations(): Invalidations {
    return {
      invalidateOnFileCreate: [],
      invalidateOnFileChange: new Set(),
      invalidateOnStartup: false,
    };
  }
  invalidate(): void {}
}

registerSerializableClass(
  `${packageJson.version}:BrowserPackageManager`,
  BrowserPackageManager,
);
