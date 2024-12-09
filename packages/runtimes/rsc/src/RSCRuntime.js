// @flow strict-local

import {Runtime} from '@parcel/plugin';
import nullthrows from 'nullthrows';
import {urlJoin} from '@parcel/utils';

export default (new Runtime({
  apply({bundle, bundleGraph}) {
    if (bundle.type !== 'js') {
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
          let usedSymbols = nullthrows(
            bundleGraph.getUsedSymbols(resolvedAsset),
          );
          if (usedSymbols.has('*')) {
            // TODO
          }

          let browserBundles = bundleGraph
            .getReferencedBundles(bundle)
            .filter(b => b.type === 'js' && b.env.isBrowser())
            .map(b => b.name);

          let code = `import {createClientReference} from "react-server-dom-parcel/server.edge";\n`;
          for (let symbol of usedSymbols) {
            let resolved = bundleGraph.getSymbolResolution(
              resolvedAsset,
              symbol,
            );
            code += `exports[${JSON.stringify(
              symbol,
            )}] = createClientReference(${JSON.stringify(
              bundleGraph.getAssetPublicId(resolved.asset),
            )}, ${JSON.stringify(resolved.exportSymbol)}, ${JSON.stringify(
              browserBundles,
            )});\n`;
          }

          code += `exports.__esModule = true;\n`;

          runtimes.push({
            filePath: resolvedAsset.filePath,
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
          let usedSymbols = nullthrows(
            bundleGraph.getUsedSymbols(resolvedAsset),
          );
          if (usedSymbols.has('*')) {
            // TODO
          }

          let code;
          if (node.value.env.isServer()) {
            // Dependency on a "use server" module from a server environment.
            // Mark each export as a server reference that can be passed to a client component as a prop.
            code = `import {registerServerReference} from "react-server-dom-parcel/server.edge";\n`;
            for (let symbol of usedSymbols) {
              let resolved = bundleGraph.getSymbolResolution(
                resolvedAsset,
                symbol,
              );
              let publicId = JSON.stringify(
                bundleGraph.getAssetPublicId(resolved.asset),
              );
              let name = JSON.stringify(resolved.exportSymbol);
              code += `exports[${JSON.stringify(
                symbol,
              )}] = registerServerReference(function() {
                let originalModule = parcelRequire(${publicId});
                let fn = originalModule[${name}];
                return fn.apply(this, arguments);
              }, ${publicId}, ${name});\n`;
            }
          } else {
            // Dependency on a "use server" module from a client environment.
            // Create a client proxy module that will call the server.
            code = `import {createServerReference} from "react-server-dom-parcel/client";\n`;
            for (let symbol of usedSymbols) {
              let resolved = bundleGraph.getSymbolResolution(
                resolvedAsset,
                symbol,
              );
              code += `exports[${JSON.stringify(
                symbol,
              )}] = createServerReference(${JSON.stringify(
                bundleGraph.getAssetPublicId(resolved.asset),
              )}, ${JSON.stringify(resolved.exportSymbol)});\n`;
            }
          }

          code += `exports.__esModule = true;\n`;

          runtimes.push({
            filePath: resolvedAsset.filePath,
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
            filePath: resolvedAsset.filePath,
            code: '',
            dependency: node.value,
            env: {sourceType: 'module'},
          });

          // Server dependency on a Resources component.
        } else if (
          node.value.env.isServer() &&
          node.value.specifier === '@parcel/runtime-rsc'
        ) {
          // Generate a component that renders scripts and stylesheets referenced by the bundle.
          let bundles = bundleGraph.getReferencedBundles(bundle);
          let code =
            'import React from "react";\nexport function Resources() {\n  return <>\n';
          for (let b of bundles) {
            if (!b.env.isBrowser()) {
              continue;
            }
            let url = urlJoin(b.target.publicUrl, b.name);
            if (b.type === 'css') {
              code += `    <link rel="stylesheet" href=${JSON.stringify(
                url,
              )} precedence="default" />\n`;
            } else if (b.type === 'js') {
              code += `    <script type="module" src=${JSON.stringify(
                url,
              )} />\n`;
            }
          }

          code += '  </>;\n}\n';

          runtimes.push({
            filePath: __filename + 'x',
            code,
            dependency: node.value,
            env: {sourceType: 'module'},
            shouldReplaceResolution: true,
          });
        }

        // Dependency on a client entry asset.
      } else if (
        Array.isArray(node.value.meta.directives) &&
        node.value.meta.directives.includes('use client-entry')
      ) {
        // Add as a conditional entry, when running on the client (not during SSR).
        runtimes.push({
          filePath: __filename,
          code: `if (typeof document !== 'undefined') {
parcelRequire(${JSON.stringify(bundleGraph.getAssetPublicId(node.value))})
}`,
          env: {sourceType: 'module'},
          isEntry: true,
        });
      }
    });

    // Register server actions in the server entry point.
    if (
      bundle.env.isServer() &&
      bundleGraph.getParentBundles(bundle).length === 0
    ) {
      let code =
        'import {registerServerActions} from "react-server-dom-parcel/server.edge";\n';
      code += `registerServerActions({\n`;
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
          bundles.add(bundlesWithAsset[0].name);
          for (let r of referenced) {
            if (r.type === 'js' && r.env.context === bundle.env.context) {
              bundles.add(r.name);
            }
          }
          code += `  ${JSON.stringify(
            bundleGraph.getAssetPublicId(node.value),
          )}: ${JSON.stringify([...bundles])},\n`;
        }
      });

      code += '});\n';
      runtimes.push({
        filePath: bundle.getMainEntry()?.filePath ?? __filename,
        code,
        isEntry: true,
        env: {sourceType: 'module'},
      });
    }

    return runtimes;
  },
}): Runtime);
