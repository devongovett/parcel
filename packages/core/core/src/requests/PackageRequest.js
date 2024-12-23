// @flow strict-local

import type {ContentKey} from '@parcel/graph';
import type {Async} from '@parcel/types';
import type {SharedReference} from '@parcel/workers';

import type {StaticRunOpts} from '../RequestTracker';
import {requestTypes} from '../RequestTracker';
import type {Bundle} from '../types';
import type BundleGraph from '../BundleGraph';
import type {BundleInfo, RunPackagerRunnerResult} from '../PackagerRunner';
import type {ConfigAndCachePath} from './ParcelConfigRequest';

import nullthrows from 'nullthrows';
import {runConfigRequest} from './ConfigRequest';
import {getDevDepRequests, runDevDepRequest} from './DevDepRequest';
import createParcelConfigRequest from './ParcelConfigRequest';

type PackageRequestInput = {|
  bundleGraph: BundleGraph,
  bundle: Bundle,
  bundleGraphReference: SharedReference,
  optionsRef: SharedReference,
  useMainThread?: boolean,
|};

export type PackageRequestResult = BundleInfo[];

type RunInput<TResult> = {|
  input: PackageRequestInput,
  ...StaticRunOpts<TResult>,
|};

export type PackageRequest = {|
  id: ContentKey,
  +type: typeof requestTypes.package_request,
  run: (RunInput<BundleInfo[]>) => Async<BundleInfo[]>,
  input: PackageRequestInput,
|};

export function createPackageRequest(
  input: PackageRequestInput,
): PackageRequest {
  return {
    type: requestTypes.package_request,
    id: input.bundleGraph.getHash(input.bundle),
    run,
    input,
  };
}

async function run({input, api, farm}) {
  let {bundleGraphReference, optionsRef, bundle, useMainThread} = input;
  let runPackage = farm.createHandle('runPackage', useMainThread);

  let start = Date.now();
  let {devDeps, invalidDevDeps} = await getDevDepRequests(api);
  let {cachePath} = nullthrows(
    await api.runRequest<null, ConfigAndCachePath>(createParcelConfigRequest()),
  );

  let {devDepRequests, configRequests, bundleInfo, invalidations} =
    (await runPackage({
      bundle,
      bundleGraphReference,
      optionsRef,
      configCachePath: cachePath,
      previousDevDeps: devDeps,
      invalidDevDeps,
      previousInvalidations: api.getInvalidations(),
    }): RunPackagerRunnerResult);

  for (let devDepRequest of devDepRequests) {
    await runDevDepRequest(api, devDepRequest);
  }

  for (let configRequest of configRequests) {
    await runConfigRequest(api, configRequest);
  }

  for (let invalidation of invalidations) {
    switch (invalidation.type) {
      case 'file':
        api.invalidateOnFileUpdate(invalidation.filePath);
        api.invalidateOnFileDelete(invalidation.filePath);
        break;
      case 'env':
        api.invalidateOnEnvChange(invalidation.key);
        break;
      case 'option':
        api.invalidateOnOptionChange(invalidation.key);
        break;
      default:
        throw new Error(`Unknown invalidation type: ${invalidation.type}`);
    }
  }

  for (let info of bundleInfo) {
    // $FlowFixMe[cannot-write] time is marked read-only, but this is the exception
    info.time = Date.now() - start;
  }

  api.storeResult(bundleInfo);
  return bundleInfo;
}
