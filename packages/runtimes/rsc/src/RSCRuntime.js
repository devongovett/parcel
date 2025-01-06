// @flow strict-local

import {Runtime} from '@parcel/plugin';
import nullthrows from 'nullthrows';
import {urlJoin, normalizeSeparators, relativeBundlePath} from '@parcel/utils';
import path from 'path';
import {hashString} from '@parcel/rust';

export default (new Runtime({
  async loadConfig({config, options}) {
    // This logic must be synced with the packager...
    let packageName = await config.getConfigFrom(
      options.projectRoot + '/index',
      [],
      {
        packageKey: 'name',
      },
    );

    let name = packageName?.contents ?? '';
    return {
      parcelRequireName: 'parcelRequire' + hashString(name).slice(-4),
    };
  },
  apply({bundle, bundleGraph, config}) {
    if (
      bundle.type !== 'js' ||
      (bundle.env.context !== 'react-server' &&
        bundle.env.context !== 'react-client')
    ) {
      return [];
    }

    let runtimes = [];
    bundle.traverse(node => {
      if (node.type === 'dependency') {
        let resolvedAsset = bundleGraph.getResolvedAsset(node.value, bundle);
        let directives = resolvedAsset?.meta?.directives;

        // Server dependency on a client component.
        if (
          node.value.env.isServer() &&
          resolvedAsset &&
          Array.isArray(directives) &&
          directives.includes('use client')
        ) {
          let bundles;
          let async = bundleGraph.resolveAsyncDependency(node.value, bundle);
          if (async?.type === 'bundle_group') {
            bundles = bundleGraph.getBundlesInBundleGroup(async.value);
          } else {
            bundles = bundleGraph.getReferencedBundles(bundle);
          }

          let jsBundles = bundles
            .filter(b => b.type === 'js' && b.env.isBrowser())
            .map(b => normalizeSeparators(b.name));

          let code = `import {createClientReference} from "react-server-dom-parcel/server.edge";\n`;
          let resources = [];
          if (node.value.priority === 'lazy') {
            // If this is an async boundary, inject CSS.
            // JS for client components in injected by prepareDestinationForModule in React.
            for (let b of bundles) {
              if (b.type === 'css') {
                resources.push(renderStylesheet(b));
              }
            }

            if (resources.length) {
              code += `let resources = ${
                resources.length > 1
                  ? '<>' + resources.join('\n') + '</>'
                  : resources[0]
              };\n`;
              code += `let resourcesSymbol = Symbol.for('react.resources');\n`;
            }
          }

          for (let symbol of bundleGraph.getExportedSymbols(
            resolvedAsset,
            bundle,
          )) {
            code += `exports[${JSON.stringify(
              symbol.exportAs,
            )}] = createClientReference(${JSON.stringify(
              bundleGraph.getAssetPublicId(symbol.asset),
            )}, ${JSON.stringify(symbol.exportSymbol)}, ${JSON.stringify(
              jsBundles,
            )});\n`;
            if (resources.length) {
              code += `exports[${JSON.stringify(
                symbol.exportAs,
              )}][resourcesSymbol] = resources;\n`;
            }
          }

          code += `exports.__esModule = true;\n`;

          if (node.value.priority === 'lazy') {
            code += 'module.exports = Promise.resolve(exports);\n';
            if (resources.length) {
              code += `module.exports[resourcesSymbol] = resources;\n`;
            }
          }

          runtimes.push({
            filePath: replaceExtension(resolvedAsset.filePath),
            code,
            dependency: node.value,
            env: {sourceType: 'module'},
          });

          // Dependency on a server action.
        } else if (
          resolvedAsset &&
          Array.isArray(directives) &&
          directives.includes('use server')
        ) {
          let code;
          if (node.value.env.isServer()) {
            // Dependency on a "use server" module from a server environment.
            // Mark each export as a server reference that can be passed to a client component as a prop.
            code = `import {registerServerReference} from "react-server-dom-parcel/server.edge";\n`;
            let publicId = JSON.stringify(
              bundleGraph.getAssetPublicId(resolvedAsset),
            );
            code += `let originalModule = parcelRequire(${publicId});\n`;
            code += `for (let key in originalModule) {\n`;
            code += `  Object.defineProperty(exports, key, {\n`;
            code += `    enumerable: true,\n`;
            code += `    get: () => {\n`;
            code += `      let value = originalModule[key];\n`;
            code += `      if (typeof value === 'function' && !value.$$typeof) {\n`;
            code += `        registerServerReference(value, ${publicId}, key);\n`;
            code += `      }\n`;
            code += `      return value;\n`;
            code += `    }\n`;
            code += `  });\n`;
            code += `}\n`;
          } else {
            // Dependency on a "use server" module from a client environment.
            // Create a client proxy module that will call the server.
            code = `import {createServerReference} from "react-server-dom-parcel/client";\n`;
            let usedSymbols = bundleGraph.getUsedSymbols(resolvedAsset);
            if (usedSymbols?.has('*')) {
              usedSymbols = null;
            }
            for (let symbol of bundleGraph.getExportedSymbols(
              resolvedAsset,
              bundle,
            )) {
              if (usedSymbols && !usedSymbols.has(symbol.exportAs)) {
                continue;
              }
              code += `exports[${JSON.stringify(
                symbol.exportAs,
              )}] = createServerReference(${JSON.stringify(
                bundleGraph.getAssetPublicId(symbol.asset),
              )}, ${JSON.stringify(symbol.exportSymbol)});\n`;
            }
          }

          code += `exports.__esModule = true;\n`;
          if (node.value.priority === 'lazy') {
            code += 'module.exports = Promise.resolve(exports);\n';
          }

          runtimes.push({
            filePath: replaceExtension(resolvedAsset.filePath),
            code,
            dependency: node.value,
            env: {sourceType: 'module'},
            shouldReplaceResolution: true,
          });

          // Server dependency on a client entry.
        } else if (
          node.value.env.isServer() &&
          resolvedAsset &&
          Array.isArray(directives) &&
          directives.includes('use client-entry')
        ) {
          // Resolve to an empty module so the client entry does not run on the server.
          runtimes.push({
            filePath: replaceExtension(resolvedAsset.filePath),
            code: '',
            dependency: node.value,
            env: {sourceType: 'module'},
          });
        } else {
          // Handle bundle group boundaries to automatically inject resources like CSS.
          // This is normally handled by the JS runtime, but we need to add resources to the
          // React tree so they get loaded during SSR as well.
          let asyncResolution = bundleGraph.resolveAsyncDependency(node.value);
          if (asyncResolution?.type === 'bundle_group') {
            let bundles = bundleGraph.getBundlesInBundleGroup(
              asyncResolution.value,
            );
            let resources = [];
            let js = [];
            let bootstrapModules = [];
            let entry;
            let hasCSS = false;
            for (let b of bundles) {
              if (b.type === 'css') {
                resources.push(renderStylesheet(b));
                if (bundle.env.isBrowser()) {
                  // If resources were requested, then a <link> element was rendered in the React tree.
                  // We don't need to wait for the CSS to render the component because React will suspend.
                  // In other cases where we aren't rendering a component, we still need to wait on the CSS.
                  let url = urlJoin(b.target.publicUrl, b.name);
                  js.push(
                    `Promise.resolve().then(() => requestedResources ? null : cssLoader(${JSON.stringify(
                      url,
                    )}))`,
                  );
                  hasCSS = true;
                }
              } else if (b.type === 'js') {
                if (b.env.isBrowser()) {
                  let url = urlJoin(b.target.publicUrl, b.name);
                  // Preload scripts for dynamic imports during SSR.
                  // TODO: is this safe? may not have prelude yet
                  resources.push(
                    `<script type="module" async src=${JSON.stringify(url)} />`,
                  );
                  bootstrapModules.push(url);
                }

                if (b.env.context === bundle.env.context) {
                  if (b.env.outputFormat === 'esmodule') {
                    js.push(`parcelRequire.load(${JSON.stringify(b.name)})`);
                  } else if (b.env.outputFormat === 'commonjs') {
                    let relativePath = JSON.stringify(
                      relativeBundlePath(bundle, b),
                    );
                    js.push(
                      `Promise.resolve(__parcel__require__(${relativePath}))`,
                    );
                  } else {
                    throw new Error(
                      'Unsupported output format: ' + b.env.outputFormat,
                    );
                  }
                }

                // Find the client entry in this bundle group if any.
                if (bundle.env.isServer() && b.env.isBrowser() && !entry) {
                  b.traverseAssets((a, ctx, actions) => {
                    if (
                      Array.isArray(a.meta.directives) &&
                      a.meta.directives.includes('use client-entry')
                    ) {
                      entry = a;
                      actions.stop();
                    }
                  });
                }
              }
            }

            if (resources) {
              // Use a proxy to attach resources to all exports.
              // This will be used by the JSX runtime to automatically render CSS at bundle group boundaries.
              let code = `let resources = ${
                resources.length > 1
                  ? '<>' + resources.join('\n') + '</>'
                  : resources[0]
              };\n`;

              if (node.value.priority === 'lazy') {
                if (hasCSS) {
                  code += `let cssLoader = require('@parcel/runtime-js/src/helpers/browser/css-loader');\n`;
                  code += 'let requestedResources = false;\n';
                }
                code += `let promise = Promise.all([${js.join(
                  ', ',
                )}]).then(() => {\n`;
              }

              // Also attach a bootstrap script which will be injected into the initial HTML.
              if (node.value.priority !== 'lazy' && entry) {
                let bootstrapScript = `Promise.all([${bootstrapModules
                  .map(m => `import("${m}")`)
                  .join(',')}]).then(()=>${
                  nullthrows(config).parcelRequireName
                }(${JSON.stringify(bundleGraph.getAssetPublicId(entry))}))`;
                code += `let bootstrapScript = ${JSON.stringify(
                  bootstrapScript,
                )};\n`;
              }

              let resolvedAsset = bundleGraph.getAssetById(
                asyncResolution.value.entryAssetId,
              );
              code += `let originalModule = parcelRequire(${JSON.stringify(
                bundleGraph.getAssetPublicId(resolvedAsset),
              )});\n`;
              code += `let res = require('@parcel/runtime-rsc/rsc-helpers').createResourcesProxy(originalModule, resources ${
                node.value.priority !== 'lazy' && entry
                  ? ', bootstrapScript'
                  : ''
              });\n`;

              if (node.value.priority === 'lazy') {
                code += `  return res;\n`;
                code += `});\n`;

                // Also attach resources to the promise itself so React.lazy can render them early.
                code += `Object.defineProperty(promise, Symbol.for('react.resources'), {
                  get() {
                    requestedResources = true;
                    return resources;
                  }
                });\n`;
                code += `module.exports = promise;\n`;
              } else {
                code += `module.exports = res;\n`;
              }

              let filePath = nullthrows(node.value.sourcePath);
              runtimes.push({
                filePath: replaceExtension(filePath),
                code,
                dependency: node.value,
                env: {sourceType: 'module'},
              });
            }
          }
        }
      }
    });

    // Register server actions in the server entry point.
    if (
      bundle.env.isServer() &&
      bundleGraph.getParentBundles(bundle).length === 0
    ) {
      let serverActions = '';
      bundleGraph.traverse(node => {
        if (
          node.type === 'asset' &&
          Array.isArray(node.value.meta?.directives) &&
          node.value.meta.directives.includes('use server')
        ) {
          let bundlesWithAsset = bundleGraph.getBundlesWithAsset(node.value);
          let bundles = new Set();
          let referenced = bundleGraph.getReferencedBundles(
            bundlesWithAsset[0],
          );
          bundles.add(normalizeSeparators(bundlesWithAsset[0].name));
          for (let r of referenced) {
            if (r.type === 'js' && r.env.context === bundle.env.context) {
              bundles.add(normalizeSeparators(r.name));
            }
          }
          serverActions += `  ${JSON.stringify(
            bundleGraph.getAssetPublicId(node.value),
          )}: ${JSON.stringify([...bundles])},\n`;
        }
      });

      let code = '';
      if (serverActions.length > 0) {
        code +=
          'import {registerServerActions} from "react-server-dom-parcel/server.edge";\n';
        code += `registerServerActions({\n`;
        code += serverActions;
        code += '});\n';
      }

      // React needs AsyncLocalStorage defined as a global for the edge environment.
      // Without this, preinit scripts won't be inserted during SSR.
      code += 'if (typeof AsyncLocalStorage === "undefined") {\n';
      code += '  try {\n';
      code +=
        '    globalThis.AsyncLocalStorage = require("node:async_hooks").AsyncLocalStorage;\n';
      code += '  } catch {}\n';
      code += '}\n';

      runtimes.push({
        filePath: replaceExtension(
          bundle.getMainEntry()?.filePath ?? __filename,
        ),
        code,
        isEntry: true,
        env: {sourceType: 'module'},
      });
    }

    return runtimes;
  },
}): Runtime);

function replaceExtension(filePath, extension = '.jsx') {
  let ext = path.extname(filePath);
  return filePath.slice(0, -ext.length) + extension;
}

function renderStylesheet(b) {
  let url = urlJoin(b.target.publicUrl, b.name);
  return `<link rel="stylesheet" href=${JSON.stringify(
    url,
  )} precedence="default" />`;
}
