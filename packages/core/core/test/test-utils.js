// @flow strict-local

import type {Environment, ParcelOptions, Target} from '../src/types';

import {FSCache} from '@parcel/cache';
import tempy from 'tempy';
import path from 'path';
import {inputFS, outputFS} from '@parcel/test-utils';
import {relativePath} from '@parcel/utils';
import {NodePackageManager} from '@parcel/package-manager';
import {createEnvironment} from '../src/Environment';
import {toProjectPath} from '../src/projectPath';
import {DEFAULT_FEATURE_FLAGS} from '@parcel/feature-flags';

let cacheDir = tempy.directory();
export let cache: FSCache = new FSCache(outputFS, cacheDir);
cache.ensure();

export const DEFAULT_OPTIONS: ParcelOptions = {
  cacheDir: path.join(__dirname, '.parcel-cache'),
  parcelVersion: '',
  watchDir: __dirname,
  watchIgnore: undefined,
  watchBackend: undefined,
  entries: [],
  logLevel: 'info',
  targets: undefined,
  projectRoot: __dirname,
  shouldAutoInstall: false,
  hmrOptions: undefined,
  shouldContentHash: true,
  shouldBuildLazily: false,
  lazyIncludes: [],
  lazyExcludes: [],
  shouldBundleIncrementally: true,
  serveOptions: false,
  mode: 'development',
  env: {},
  shouldDisableCache: false,
  shouldProfile: false,
  shouldTrace: false,
  inputFS,
  outputFS,
  cache,
  shouldPatchConsole: false,
  packageManager: new NodePackageManager(inputFS, '/'),
  additionalReporters: [],
  instanceId: 'test',
  defaultTargetOptions: {
    shouldScopeHoist: false,
    shouldOptimize: false,
    publicUrl: '/',
    distDir: undefined,
    sourceMaps: false,
  },
  featureFlags: {
    ...DEFAULT_FEATURE_FLAGS,
  },
};

export const DEFAULT_ENV: Environment = createEnvironment({
  context: 'browser',
  engines: {
    browsers: ['> 1%'],
  },
});

export const DEFAULT_TARGETS: Array<Target> = [
  {
    name: 'test',
    distDir: toProjectPath('/', '/dist'),
    distEntry: 'out.js',
    env: DEFAULT_ENV,
    publicUrl: '/',
  },
];

export function relative(f: string): string {
  return relativePath(__dirname, f, false);
}
