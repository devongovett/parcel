// @flow strict-local
import type {Bundle, BundleGraph, NamedBundle} from '@parcel/types';

import assert from 'assert';
import {Readable} from 'stream';
import {Packager} from '@parcel/plugin';
import posthtml from 'posthtml';
import {
  bufferStream,
  replaceInlineReferences,
  replaceURLReferences,
  urlJoin,
  getImportMap,
} from '@parcel/utils';
import nullthrows from 'nullthrows';

// https://www.w3.org/TR/html5/dom.html#metadata-content-2
const metadataContent = new Set([
  'base',
  'link',
  'meta',
  'noscript',
  // 'script', // retain script order (somewhat)
  'style',
  'template',
  'title',
]);

export default (new Packager({
  async loadConfig({config}) {
    let posthtmlConfig = await config.getConfig(
      [
        '.posthtmlrc',
        '.posthtmlrc.js',
        '.posthtmlrc.cjs',
        '.posthtmlrc.mjs',
        'posthtml.config.js',
        'posthtml.config.cjs',
        'posthtml.config.mjs',
      ],
      {
        packageKey: 'posthtml',
      },
    );
    return {
      render: posthtmlConfig?.contents?.render,
    };
  },
  async package({bundle, bundleGraph, getInlineBundleContents, config}) {
    let assets = [];
    bundle.traverseAssets(asset => {
      assets.push(asset);
    });

    assert.equal(assets.length, 1, 'HTML bundles must only contain one asset');

    let asset = assets[0];
    let code = await asset.getCode();

    let renderConfig = config?.render;

    let {html} = await posthtml([
      // Add bundles in the same bundle group that are not inline. For example, if two inline
      // bundles refer to the same library that is extracted into a shared bundle.
      tree => insertBundleReferences(bundleGraph, bundle, tree),
      tree =>
        replaceInlineAssetContent(bundleGraph, getInlineBundleContents, tree),
    ]).process(code, {
      ...renderConfig,
      xmlMode: bundle.type === 'xhtml',
      closingSingleTag: bundle.type === 'xhtml' ? 'slash' : undefined,
    });

    let {contents, map} = replaceURLReferences({
      bundle,
      bundleGraph,
      contents: html,
      relative: false,
      getReplacement: contents => contents.replace(/"/g, '&quot;'),
    });

    return replaceInlineReferences({
      bundle,
      bundleGraph,
      contents,
      getInlineBundleContents,
      getInlineReplacement: (dep, inlineType, contents) => ({
        from: dep.id,
        to: contents.replace(/"/g, '&quot;').trim(),
      }),
      map,
    });
  },
}): Packager);

async function getAssetContent(
  bundleGraph: BundleGraph<NamedBundle>,
  getInlineBundleContents,
  assetId,
) {
  let inlineBundle: ?Bundle;
  bundleGraph.traverseBundles((bundle, context, {stop}) => {
    let entryAssets = bundle.getEntryAssets();
    if (entryAssets.some(a => a.uniqueKey === assetId)) {
      inlineBundle = bundle;
      stop();
    }
  });

  if (inlineBundle) {
    const bundleResult = await getInlineBundleContents(
      inlineBundle,
      bundleGraph,
    );

    return {bundle: inlineBundle, contents: bundleResult.contents};
  }

  return null;
}

async function replaceInlineAssetContent(
  bundleGraph: BundleGraph<NamedBundle>,
  getInlineBundleContents,
  tree,
) {
  const inlineNodes = [];
  tree.walk(node => {
    if (node.attrs && node.attrs['data-parcel-key']) {
      inlineNodes.push(node);
    }
    return node;
  });

  for (let node of inlineNodes) {
    let newContent = await getAssetContent(
      bundleGraph,
      getInlineBundleContents,
      node.attrs['data-parcel-key'],
    );

    if (newContent != null) {
      let {contents, bundle} = newContent;
      node.content = (
        contents instanceof Readable ? await bufferStream(contents) : contents
      ).toString();

      if (
        node.tag === 'script' &&
        nullthrows(bundle).env.outputFormat === 'esmodule'
      ) {
        node.attrs.type = 'module';
      }

      // Escape closing script tags and HTML comments in JS content.
      // https://www.w3.org/TR/html52/semantics-scripting.html#restrictions-for-contents-of-script-elements
      // Avoid replacing </script with <\/script as it would break the following valid JS: 0</script/ (i.e. regexp literal).
      // Instead, escape the s character.
      if (node.tag === 'script') {
        node.content = node.content
          .replace(/<!--/g, '<\\!--')
          .replace(/<\/(script)/gi, '</\\$1');
      }

      // Escape closing style tags in CSS content.
      if (node.tag === 'style') {
        node.content = node.content.replace(/<\/(style)/gi, '<\\/$1');
      }

      // remove attr from output
      delete node.attrs['data-parcel-key'];
    }
  }

  return tree;
}

function insertBundleReferences(bundleGraph, htmlBundle, tree) {
  let bundles = [];
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
        tag: 'link',
        attrs: {
          rel: 'stylesheet',
          href: urlJoin(bundle.target.publicUrl, bundle.name),
        },
      });
    } else if (bundle.type === 'js' && !isDirectlyReferenced) {
      let nomodule =
        bundle.env.outputFormat !== 'esmodule' &&
        bundle.env.sourceType === 'module' &&
        bundle.env.shouldScopeHoist;
      bundles.push({
        tag: 'script',
        attrs: {
          type: bundle.env.outputFormat === 'esmodule' ? 'module' : undefined,
          nomodule: nomodule ? '' : undefined,
          defer: nomodule ? '' : undefined,
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

    // If there is an existing <script type="importmap">, merge with that.
    // This will remove the existing node so it is moved before all other scripts.
    let existingImportMap = findImportMap(tree);

    if (existingImportMap) {
      if (!existingImportMap.imports) {
        existingImportMap.imports = {};
      }
      importMap = Object.assign(existingImportMap.imports, importMap);
    }

    bundles.unshift({
      tag: 'script',
      attrs: {
        type: 'importmap',
      },
      content: JSON.stringify({imports: importMap}),
    });
  }

  addBundlesToTree(bundles, tree);
}

function addBundlesToTree(bundles, tree) {
  const main = find(tree, 'head') || find(tree, 'html');
  const content = main ? main.content || (main.content = []) : tree;
  const index = findBundleInsertIndex(content);

  content.splice(index, 0, ...bundles);
}

function findImportMap(tree) {
  if (Array.isArray(tree)) {
    for (let i = 0; i < tree.length; i++) {
      let node = tree[i];
      if (
        node.tag === 'script' &&
        node.attrs?.type === 'importmap' &&
        Array.isArray(node.content)
      ) {
        let importMap = JSON.parse(node.content.join(''));
        tree.splice(i, 1);
        return importMap;
      } else {
        let res = findImportMap(node);
        if (res) {
          return res;
        }
      }
    }
  } else if (tree && typeof tree.content === 'object') {
    return findImportMap(tree.content);
  }
}

function find(tree, tag) {
  let res;
  tree.match({tag}, node => {
    res = node;
    return node;
  });

  return res;
}

function findBundleInsertIndex(content) {
  // HTML document order (https://html.spec.whatwg.org/multipage/syntax.html#writing)
  //   - Any number of comments and ASCII whitespace.
  //   - A DOCTYPE.
  //   - Any number of comments and ASCII whitespace.
  //   - The document element, in the form of an html element.
  //   - Any number of comments and ASCII whitespace.
  //
  // -> Insert before first non-metadata (or script) element; if none was found, after the doctype

  let doctypeIndex;
  for (let index = 0; index < content.length; index++) {
    const node = content[index];
    if (node && node.tag && !metadataContent.has(node.tag)) {
      return index;
    }
    if (
      typeof node === 'string' &&
      node.toLowerCase().startsWith('<!doctype')
    ) {
      doctypeIndex = index;
    }
  }

  return doctypeIndex ? doctypeIndex + 1 : 0;
}
