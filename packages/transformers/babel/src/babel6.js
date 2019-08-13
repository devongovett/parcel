// @flow

import type {LocalRequire, MutableAsset, AST} from '@parcel/types';

import {babel6toBabel7} from './astConverter';

export default async function babel6(
  asset: MutableAsset,
  localRequire: LocalRequire,
  options: any
): Promise<?AST> {
  let babel = await localRequire('babel-core', asset.filePath);

  let config = options.config;
  config.code = false;
  config.ast = true;
  config.filename = asset.filePath;
  config.babelrc = false;
  config.parserOpts = Object.assign({}, config.parserOpts, {
    allowReturnOutsideFunction: true,
    allowHashBang: true,
    ecmaVersion: Infinity,
    strictMode: false,
    sourceType: 'module',
    locations: true
  });

  // Passing a list of plugins as part of parserOpts seems to override any custom
  // syntax plugins a user might have added (e.g. decorators). We add dynamicImport
  // using a plugin instead.
  config.plugins = (config.plugins || []).concat(dynamicImport);

  let res = babel.transform(await asset.getCode(), config);
  if (res.ast) {
    return {
      type: 'babel',
      version: '7.0.0',
      program: babel6toBabel7(res.ast)
    };
  }
}

function dynamicImport() {
  return {
    manipulateOptions(opts, parserOpts) {
      parserOpts.plugins.push('dynamicImport');
    }
  };
}
