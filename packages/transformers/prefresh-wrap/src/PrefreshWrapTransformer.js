// @flow

import path from 'path';
import {Transformer} from '@parcel/plugin';

function shouldExclude(asset, options) {
  return (
    !asset.isSource ||
    !options.hmrOptions ||
    !asset.env.isBrowser() ||
    asset.env.isLibrary ||
    asset.env.isWorker() ||
    asset.env.isWorklet() ||
    options.mode !== 'development' ||
    !asset.getDependencies().find(v => {
      return (
        v.specifier === 'preact' ||
        v.specifier === 'preact/jsx-runtime' ||
        v.specifier === 'preact/jsx-dev-runtime'
      );
    })
  );
}

export default (new Transformer({
  async transform({asset, options}) {
    if (shouldExclude(asset, options)) {
      return [asset];
    }

    let wrapperPath = `@parcel/transformer-prefresh-wrap/${path.basename(
      __dirname,
    )}/helpers/helpers.js`;

    let code = await asset.getCode();
    let map = await asset.getMap();
    let name = `$parcel$PrefreshHelpers$${asset.id.slice(-4)}`;

    code = `self.${name} = require(${JSON.stringify(wrapperPath)});
var prevRefreshReg = window.$RefreshReg$;
var prevRefreshSig = window.$RefreshSig$;
${name}.prelude(module);

try {
${code}
  ${name}.postlude(module);
} finally {
  window.$RefreshReg$ = prevRefreshReg;
  window.$RefreshSig$ = prevRefreshSig;
}`;

    asset.setCode(code);
    if (map) {
      map.offsetLines(1, 12);
      asset.setMap(map);
    }

    // The JSTransformer has already run, do it manually
    asset.addDependency({
      specifier: wrapperPath,
      specifierType: 'esm',
      resolveFrom: __filename,
    });

    return [asset];
  },
}): Transformer);
