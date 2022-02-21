// @flow

import {Transformer} from '@parcel/plugin';

import path from 'path';
import camelcase from 'camelcase';
import svgoPlugin from '@svgr/plugin-svgo';
import jsxPlugin from '@svgr/plugin-jsx';
import {transform} from '@svgr/core';

function getComponentName(filePath) {
  let validCharacters = /[^a-zA-Z0-9_-]/g;
  let name = path.parse(filePath).name.replace(validCharacters, '');
  return camelcase(name, {
    pascalCase: true,
  });
}

export default (new Transformer({
  async loadConfig({config}) {
    let { contents } = await config.getConfig(['.svgrrc', '.svgrrc.json']);
    return contents;
  },

  async transform({asset,config}) {
    let code = await asset.getCode();
    let componentName = getComponentName(asset.filePath);

    const jsx = await transform(
      code,
      { ...config, runtimeConfig: false },
      {
        caller: {
          name: '@parcel/transformer-svg-react',
          defaultPlugins: [svgoPlugin, jsxPlugin],
        },
        componentName,
        filePath: asset.filePath,
      },
    );

    asset.type = 'jsx';
    asset.bundleBehavior = null;
    asset.setCode(jsx);

    return [asset];
  },
}): Transformer);
