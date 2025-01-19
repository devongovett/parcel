// @flow

import {Resolver} from '@parcel/plugin';
import fs from 'fs';
import path from 'path';

const FILES = new Map([
  [
    '/app/packages/runtimes/js/src/helpers/cacheLoader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/cacheLoader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/get-worker-url.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/get-worker-url.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/preload-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/preload-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/prefetch-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/prefetch-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/css-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/css-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/html-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/html-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/js-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/js-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/wasm-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/wasm-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/browser/import-polyfill.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/browser/import-polyfill.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/worker/js-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/worker/js-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/worker/wasm-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/worker/wasm-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/node/css-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/node/css-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/node/html-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/node/html-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/node/js-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/node/js-loader.js',
      'utf8',
    ),
  ],
  [
    '/app/packages/runtimes/js/src/helpers/node/wasm-loader.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/runtimes/js/src/helpers/node/wasm-loader.js',
      'utf8',
    ),
  ],
  [
    '@parcel/transformer-js/src/esmodule-helpers.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/transformers/js/src/esmodule-helpers.js',
      'utf8',
    ),
  ],
  [
    '@parcel/transformer-react-refresh-wrap/src/helpers/helpers.js',
    fs.readFileSync(
      __dirname +
        '/../../../../packages/transformers/react-refresh-wrap/src/helpers/helpers.js',
      'utf8',
    ),
  ],
]);

const REACT_ERROR_OVERLAY = fs.readFileSync(
  __dirname + '/../../../../node_modules/react-error-overlay/lib/index.js',
  'utf8',
);

export default (new Resolver({
  resolve({dependency}) {
    let {specifier, resolveFrom} = dependency;

    if (resolveFrom && resolveFrom.startsWith('/app/packages/')) {
      if (
        specifier === 'react-error-overlay' &&
        resolveFrom.startsWith('/app/packages/runtimes/react-refresh/src/')
      ) {
        return {
          filePath: `/react-error-overlay/lib/index.js`,
          code: REACT_ERROR_OVERLAY,
        };
      }

      let resolvedPath = specifier.startsWith('.')
        ? path.resolve(path.dirname(resolveFrom), specifier)
        : specifier;

      let filePath;
      let code;
      if (FILES.has(resolvedPath)) {
        filePath = resolvedPath;
        code = FILES.get(resolvedPath);
      } else if (FILES.has(resolvedPath + '.js')) {
        filePath = resolvedPath + '.js';
        code = FILES.get(resolvedPath + '.js');
      }

      if (filePath && code) {
        return {
          filePath: filePath.startsWith('@')
            ? `/app/node_modules/${filePath}`
            : filePath,
          code,
        };
      }
    }
  },
}): Resolver);
