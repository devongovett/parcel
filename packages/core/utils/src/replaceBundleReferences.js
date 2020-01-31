// @flow strict-local

import type SourceMap from '@parcel/source-map';
import type {
  Async,
  Blob,
  Bundle,
  BundleResult,
  BundleGraph,
  Dependency,
} from '@parcel/types';

import {Readable} from 'stream';
import nullthrows from 'nullthrows';
import URL from 'url';
import {bufferStream, relativeBundlePath, urlJoin} from '../';

type ReplacementMap = Map<
  string /* dependency id */,
  {|from: string, to: string|},
>;

/*
 * Replaces references to dependency ids with either:
 *   - in the case of an inline bundle, the packaged contents of that bundle
 *   - in the case of another bundle reference, the bundle's url from the publicUrl root
 *   - in the case of a url dependency that Parcel did not handle,
 *     the original moduleSpecifier. These are external requests.
 */
export async function replaceBundleReferences({
  bundle,
  bundleGraph,
  contents,
  map,
  replaceInline,
  replaceUrls = true,
  relative = true,
}: {|
  bundle: Bundle,
  bundleGraph: BundleGraph,
  contents: string,
  relative?: boolean,
  replaceInline?: {|
    getInlineReplacement: (
      Dependency,
      ?'string',
      string,
    ) => {|from: string, to: string|},
    getInlineBundleContents: (
      Bundle,
      BundleGraph,
    ) => Async<{|contents: Blob, map: ?(Readable | string)|}>,
  |},
  replaceUrls?: boolean,
  map?: ?SourceMap,
|}): Promise<BundleResult> {
  let replacements = new Map();

  for (let dependency of bundleGraph.getExternalDependencies(bundle)) {
    let bundleGroup = bundleGraph.resolveExternalDependency(dependency);
    if (bundleGroup == null) {
      if (replaceUrls) {
        replacements.set(dependency.id, {
          from: dependency.id,
          to: dependency.moduleSpecifier,
        });
      }
      continue;
    }

    let [entryBundle] = bundleGraph.getBundlesInBundleGroup(bundleGroup);
    if (entryBundle.isInline) {
      if (replaceInline != null) {
        // inline bundles
        let packagedBundle = await replaceInline.getInlineBundleContents(
          entryBundle,
          bundleGraph,
        );
        let packagedContents = (packagedBundle.contents instanceof Readable
          ? await bufferStream(packagedBundle.contents)
          : packagedBundle.contents
        ).toString();

        let inlineType = nullthrows(entryBundle.getMainEntry()).meta.inlineType;
        if (inlineType == null || inlineType === 'string') {
          replacements.set(
            dependency.id,
            replaceInline.getInlineReplacement(
              dependency,
              inlineType,
              packagedContents,
            ),
          );
        }
      }
    } else if (dependency.isURL && replaceUrls) {
      // url references
      replacements.set(
        dependency.id,
        getURLReplacement({
          dependency,
          fromBundle: bundle,
          toBundle: entryBundle,
          relative,
        }),
      );
    }
  }

  return performReplacement(replacements, contents, map);
}

function getURLReplacement({
  dependency,
  fromBundle,
  toBundle,
  relative,
}: {|
  dependency: Dependency,
  fromBundle: Bundle,
  toBundle: Bundle,
  relative: boolean,
|}) {
  let url = URL.parse(dependency.moduleSpecifier);
  let to;
  if (relative) {
    url.pathname = relativeBundlePath(fromBundle, toBundle, {
      leadingDotSlash: false,
    });
    to = URL.format(url);
  } else {
    url.pathname = nullthrows(toBundle.name);
    to = urlJoin(nullthrows(toBundle.target.publicUrl), URL.format(url));
  }

  return {
    from: dependency.id,
    to,
  };
}

function performReplacement(
  replacements: ReplacementMap,
  contents: string,
  map?: ?SourceMap,
): BundleResult {
  let finalContents = contents;
  for (let {from, to} of replacements.values()) {
    // Perform replacement
    finalContents = finalContents.split(from).join(to);
  }

  return {
    contents: finalContents,
    // TODO: Update sourcemap with adjusted contents
    map,
  };
}
