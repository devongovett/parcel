// @flow strict-local

import type {FilePath, PackageJSON} from '@parcel/types';
import type {WorkerApi} from '@parcel/workers';

import installPackage, {
  installPackageFromWorker
} from '@parcel/install-package';
import {dirname} from 'path';
import {resolve} from '@parcel/utils';
import {NodeFS} from '@parcel/fs';

const cache: Map<string, [string, ?PackageJSON]> = new Map();
const nodeFS = new NodeFS();

export async function localRequireFromWorker(
  workerApi: WorkerApi,
  name: string,
  path: FilePath,
  triedInstall: boolean = false
  // $FlowFixMe this must be dynamic
): Promise<any> {
  let [resolved] = await localResolveFromWorker(
    workerApi,
    name,
    path,
    triedInstall
  );
  // $FlowFixMe this must be dynamic
  return require(resolved);
}

async function localResolveBase(
  name: string,
  path: FilePath,
  triedInstall: boolean = false,
  install: (Array<string>, FilePath) => Promise<mixed>
): Promise<[string, ?PackageJSON]> {
  let basedir = dirname(path);
  let key = basedir + ':' + name;
  let resolved = cache.get(key);
  if (!resolved) {
    try {
      resolved = await resolve(nodeFS, name, {
        basedir,
        extensions: ['.js', '.json']
      });
    } catch (e) {
      if (e.code === 'MODULE_NOT_FOUND' && !triedInstall) {
        await install([name], path);
        return localResolve(name, path, true);
      }
      throw e;
    }
    cache.set(key, resolved);
  }

  return resolved;
}

export function localResolve(
  name: string,
  path: FilePath,
  triedInstall: boolean = false
): Promise<[string, ?PackageJSON]> {
  return localResolveBase(name, path, triedInstall, installPackage);
}

export function localResolveFromWorker(
  workerApi: WorkerApi,
  name: string,
  path: FilePath,
  triedInstall: boolean = false
) {
  return localResolveBase(
    name,
    path,
    triedInstall,
    installPackageFromWorker.bind(null, workerApi)
  );
}
