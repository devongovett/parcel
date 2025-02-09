// @flow

import type {BundleGraph, NamedBundle} from '@parcel/types';
import assert from 'assert';
import {Packager} from '@parcel/plugin';
import {blobToString, urlJoin, getURLReplacement} from '@parcel/utils';
import {
  packageSvg,
  type HtmlBundleReference,
  type HtmlInlineBundle,
} from '@parcel/rust';
import invariant from 'assert';

export default (new Packager({
  async package({bundle, bundleGraph, getInlineBundleContents}) {
    const assets = [];
    bundle.traverseAssets(asset => {
      assets.push(asset);
    });

    assert.strictEqual(
      assets.length,
      1,
      'SVG bundles must only contain one asset',
    );

    let asset = assets[0];
    let code = await asset.getBuffer();

    let {bundles, importMap} = getBundleReferences(bundleGraph, bundle);
    let inlineBundles = await getInlineBundles(
      bundleGraph,
      bundle,
      getInlineBundleContents,
    );

    let res = packageSvg({
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
      let packagedContents = await blobToString(packagedBundle.contents);

      // Wrap scripts and styles with CDATA if needed to ensure characters are not interpreted as XML
      if (entryBundle.type === 'js' || entryBundle.type === 'css') {
        if (packagedContents.includes('<') || packagedContents.includes('&')) {
          packagedContents = packagedContents.replace(/]]>/g, ']\\]>');
          packagedContents = `<![CDATA[\n${packagedContents}\n]]>`;
        }
      }

      let placeholder = dependency.meta?.placeholder ?? dependency.id;
      invariant(typeof placeholder === 'string');
      inlineBundles[placeholder] = {
        contents: packagedContents,
        module: false,
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
      bundles.push({
        type: 'Script',
        value: {
          module: false,
          nomodule: false,
          src: urlJoin(bundle.target.publicUrl, bundle.name),
        },
      });
    }
  }

  return {bundles, importMap};
}
