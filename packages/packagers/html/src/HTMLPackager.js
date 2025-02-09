// @flow strict-local
import type {BundleGraph, NamedBundle} from '@parcel/types';

import assert from 'assert';
import {Readable} from 'stream';
import {Packager} from '@parcel/plugin';
import {
  bufferStream,
  urlJoin,
  getImportMap,
  getURLReplacement,
} from '@parcel/utils';
import {
  packageHtml,
  type HtmlBundleReference,
  type HtmlInlineBundle,
} from '@parcel/rust';
import invariant from 'assert';

export default (new Packager({
  async package({bundle, bundleGraph, getInlineBundleContents}) {
    let assets = [];
    bundle.traverseAssets(asset => {
      assets.push(asset);
    });

    assert.equal(assets.length, 1, 'HTML bundles must only contain one asset');

    let asset = assets[0];
    let code = await asset.getBuffer();

    let {bundles, importMap} = getBundleReferences(bundleGraph, bundle);
    let inlineBundles = await getInlineBundles(
      bundleGraph,
      bundle,
      getInlineBundleContents,
    );

    let res = packageHtml({
      code,
      bundles,
      inlineBundles,
      importMap,
    });

    return {contents: res.code};
  },
}): Packager);

async function getInlineBundles(
  bundleGraph: BundleGraph<NamedBundle>,
  bundle: NamedBundle,
  getInlineBundleContents,
) {
  let inlineBundles: {|[string]: HtmlInlineBundle|} = {};

  let dependencies = [];
  bundle.traverse(node => {
    if (node.type === 'dependency') {
      dependencies.push(node.value);
    }
  });

  for (let dependency of dependencies) {
    let entryBundle = bundleGraph.getReferencedBundle(dependency, bundle);
    if (entryBundle?.bundleBehavior === 'inline') {
      let packagedBundle = await getInlineBundleContents(
        entryBundle,
        bundleGraph,
      );
      let packagedContents = (
        packagedBundle.contents instanceof Readable
          ? await bufferStream(packagedBundle.contents)
          : packagedBundle.contents
      ).toString();

      // Escape closing script tags and HTML comments in JS content.
      // https://www.w3.org/TR/html52/semantics-scripting.html#restrictions-for-contents-of-script-elements
      // Avoid replacing </script with <\/script as it would break the following valid JS: 0</script/ (i.e. regexp literal).
      // Instead, escape the s character.
      if (entryBundle.type === 'js') {
        packagedContents = packagedContents
          .replace(/<!--/g, '<\\!--')
          .replace(/<\/(script)/gi, '</\\$1');
      }

      // Escape closing style tags in CSS content.
      if (entryBundle.type === 'css') {
        packagedContents = packagedContents.replace(/<\/(style)/gi, '<\\/$1');
      }

      let placeholder = dependency.meta?.placeholder ?? dependency.id;
      invariant(typeof placeholder === 'string');
      inlineBundles[placeholder] = {
        contents: packagedContents,
        module: entryBundle.env.outputFormat === 'esmodule',
      };
    } else if (dependency.specifierType === 'url') {
      let placeholder = dependency.meta?.placeholder ?? dependency.id;
      invariant(typeof placeholder === 'string');
      inlineBundles[placeholder] = {
        contents: entryBundle
          ? getURLReplacement({
              dependency,
              fromBundle: bundle,
              toBundle: entryBundle,
              relative: false,
            }).to
          : dependency.specifier,
        module: false,
      };
    }
  }

  return inlineBundles;
}

function getBundleReferences(bundleGraph, htmlBundle) {
  let bundles: HtmlBundleReference[] = [];
  let importMap = {};

  let useImportMap = htmlBundle.env.supports('import-meta-resolve');
  let referencedBundles = new Set(bundleGraph.getReferencedBundles(htmlBundle));
  let nonRecursiveReferencedBundles = new Set(
    bundleGraph.getReferencedBundles(htmlBundle, {recursive: false}),
  );

  for (let bundle of referencedBundles) {
    let isDirectlyReferenced = nonRecursiveReferencedBundles.has(bundle);
    if (bundle.type === 'css' && !isDirectlyReferenced) {
      bundles.push({
        type: 'StyleSheet',
        value: {
          href: urlJoin(bundle.target.publicUrl, bundle.name),
        },
      });
    } else if (bundle.type === 'js' && !isDirectlyReferenced) {
      let nomodule =
        bundle.env.outputFormat !== 'esmodule' &&
        bundle.env.sourceType === 'module' &&
        bundle.env.shouldScopeHoist;
      bundles.push({
        type: 'Script',
        value: {
          module: bundle.env.outputFormat === 'esmodule',
          nomodule,
          src: urlJoin(bundle.target.publicUrl, bundle.name),
        },
      });
    }

    if (useImportMap && bundle.type === 'js') {
      Object.assign(importMap, getImportMap(bundleGraph, bundle));
    }
  }

  if (useImportMap && Object.keys(importMap).length > 0) {
    for (let id in importMap) {
      importMap[id] = urlJoin(htmlBundle.target.publicUrl, importMap[id]);
    }
  }

  return {bundles, importMap};
}
