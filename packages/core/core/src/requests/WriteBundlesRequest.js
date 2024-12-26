// @flow strict-local

import type {ContentKey} from '@parcel/graph';
import type {Async} from '@parcel/types';
import type {SharedReference} from '@parcel/workers';
import type {StaticRunOpts} from '../RequestTracker';
import {requestTypes} from '../RequestTracker';
import type {PackagedBundleInfo} from '../types';
import type BundleGraph from '../BundleGraph';
import type {BundleInfo} from '../PackagerRunner';

import {HASH_REF_PREFIX} from '../constants';
import {joinProjectPath} from '../projectPath';
import nullthrows from 'nullthrows';
import {hashString} from '@parcel/rust';
import {createPackageRequest} from './PackageRequest';
import createWriteBundleRequest from './WriteBundleRequest';

type WriteBundlesRequestInput = {|
  bundleGraph: BundleGraph,
  optionsRef: SharedReference,
|};

export type WriteBundlesRequestResult = Map<string, PackagedBundleInfo[]>;

type RunInput<TResult> = {|
  input: WriteBundlesRequestInput,
  ...StaticRunOpts<TResult>,
|};

export type WriteBundlesRequest = {|
  id: ContentKey,
  +type: typeof requestTypes.write_bundles_request,
  run: (
    RunInput<WriteBundlesRequestResult>,
  ) => Async<WriteBundlesRequestResult>,
  input: WriteBundlesRequestInput,
|};

/**
 * Packages, optimizes, and writes all bundles to the dist directory.
 */
export default function createWriteBundlesRequest(
  input: WriteBundlesRequestInput,
): WriteBundlesRequest {
  return {
    type: requestTypes.write_bundles_request,
    id: 'write_bundles:' + input.bundleGraph.getBundleGraphHash(),
    run,
    input,
  };
}

async function run({input, api, farm, options}) {
  let {bundleGraph, optionsRef} = input;
  let {ref, dispose} = await farm.createSharedReference(bundleGraph);

  api.invalidateOnOptionChange('shouldContentHash');

  let res = new Map();
  let bundleInfoMap: {|
    [string]: BundleInfo[],
  |} = {};
  let writeEarlyPromises: {[string]: Promise<PackagedBundleInfo[]>} = {};
  let hashRefToNameHash = new Map();
  let bundles = bundleGraph.getBundles().filter(bundle => {
    // Do not package and write placeholder bundles to disk. We just
    // need to update the name so other bundles can reference it.
    if (bundle.isPlaceholder) {
      let hash = bundle.id.slice(-8);
      hashRefToNameHash.set(bundle.hashReference, hash);
      let name = nullthrows(
        bundle.name,
        `Expected ${bundle.type} bundle to have a name`,
      ).replace(bundle.hashReference, hash);
      res.set(bundle.id, [
        {
          filePath: joinProjectPath(bundle.target.distDir, name),
          type: bundle.type, // FIXME: this is wrong if the packager changes the type...
          stats: {
            time: 0,
            size: 0,
          },
        },
      ]);
      return false;
    }

    return true;
  });

  // Package on the main thread if there is only one bundle to package.
  // This avoids the cost of serializing the bundle graph for single file change builds.
  let useMainThread =
    bundles.length === 1 ||
    bundles.filter(b => !api.canSkipSubrequest(bundleGraph.getHash(b)))
      .length === 1;

  try {
    await Promise.all(
      bundles.map(async bundle => {
        let request = createPackageRequest({
          bundle,
          bundleGraph,
          bundleGraphReference: ref,
          optionsRef,
          useMainThread,
        });

        let infos = await api.runRequest(request);

        if (!useMainThread) {
          // Force a refresh of the cache to avoid a race condition
          // between threaded reads and writes that can result in an LMDB cache miss:
          //   1. The main thread has read some value from cache, necessitating a read transaction.
          //   2. Concurrently, Thread A finishes a packaging request.
          //   3. Subsequently, the main thread is tasked with this request, but fails because the read transaction is stale.
          // This only occurs if the reading thread has a transaction that was created before the writing thread committed,
          // and the transaction is still live when the reading thread attempts to get the written value.
          // See https://github.com/parcel-bundler/parcel/issues/9121
          options.cache.refresh();
        }

        bundleInfoMap[bundle.id] = infos;
        if (infos.every(info => info.hashReferences.length === 0)) {
          hashRefToNameHash.set(
            bundle.hashReference,
            options.shouldContentHash
              ? infos.length === 1
                ? infos[0].hash.slice(-8)
                : hashString(infos.map(i => i.hash).join(':')).slice(-8)
              : bundle.id.slice(-8),
          );
          for (let info of infos) {
            let writeBundleRequest = createWriteBundleRequest({
              bundle,
              info,
              hashRefToNameHash,
              bundleGraph,
            });
            let promise = api.runRequest(writeBundleRequest);
            // If the promise rejects before we await it (below), we don't want to crash the build.
            promise.catch(() => {});
            writeEarlyPromises[info.cacheKeys.content] = promise;
          }
        }
      }),
    );
    assignComplexNameHashes(hashRefToNameHash, bundles, bundleInfoMap, options);
    await Promise.all(
      bundles.map(bundle => {
        let promise = Promise.all(
          bundleInfoMap[bundle.id].map(info => {
            return (
              writeEarlyPromises[info.cacheKeys.content] ??
              api.runRequest(
                createWriteBundleRequest({
                  bundle,
                  info,
                  hashRefToNameHash,
                  bundleGraph,
                }),
              )
            );
          }),
        );

        return promise.then(r => res.set(bundle.id, r.flat()));
      }),
    );

    api.storeResult(res);
    return res;
  } finally {
    await dispose();
  }
}

function assignComplexNameHashes(
  hashRefToNameHash,
  bundles,
  bundleInfoMap,
  options,
) {
  for (let bundle of bundles) {
    if (hashRefToNameHash.get(bundle.hashReference) != null) {
      continue;
    }
    hashRefToNameHash.set(
      bundle.hashReference,
      options.shouldContentHash
        ? hashString(
            [...getBundlesIncludedInHash(bundle.id, bundleInfoMap)]
              .flatMap(bundleId => bundleInfoMap[bundleId].map(i => i.hash))
              .join(':'),
          ).slice(-8)
        : bundle.id.slice(-8),
    );
  }
}

function getBundlesIncludedInHash(
  bundleId,
  bundleInfoMap,
  included = new Set(),
) {
  included.add(bundleId);
  for (let info of bundleInfoMap[bundleId]) {
    for (let hashRef of info.hashReferences) {
      let referencedId = getIdFromHashRef(hashRef);
      if (!included.has(referencedId)) {
        getBundlesIncludedInHash(referencedId, bundleInfoMap, included);
      }
    }
  }

  return included;
}

function getIdFromHashRef(hashRef: string) {
  return hashRef.slice(HASH_REF_PREFIX.length);
}
