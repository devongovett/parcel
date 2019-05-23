// @flow

import {Transformer} from '@parcel/plugin';

import posthtml from 'posthtml';
import parse from 'posthtml-parser';
import render from 'posthtml-render';
import nullthrows from 'nullthrows';
import semver from 'semver';
import loadPlugins from './loadPlugins';

const getPostHTMLConfig = async asset => {
  let config = await asset.getConfig(
    ['.posthtmlrc', '.posthtmlrc.js', 'posthtml.config.js'],
    {
      packageKey: 'posthtml'
    }
  );

  config = config || {};

  // load plugins
  config.plugins = await loadPlugins(config.plugins, asset.filePath);

  // tells posthtml that we have already called parse
  config.skipParse = true;
  return config;
};

export default new Transformer({
  async getConfig({asset}) {
    return getPostHTMLConfig(asset);
  },

  canReuseAST({ast}) {
    return ast.type === 'posthtml' && semver.satisfies(ast.version, '^0.11.3');
  },

  async parse({asset, config}) {
    // if we don't have a config it is posthtml is not configure, don't parse
    if (!config) {
      return;
    }

    return {
      type: 'posthtml',
      version: '0.11.3',
      program: parse(await asset.getCode(), {
        lowerCaseAttributeNames: true
      })
    };
  },

  async transform({asset, config}) {
    if (!config) {
      return [asset];
    }

    let res = await posthtml(config.plugins).process(asset.ast.program, config);

    asset.ast.program = res.tree;

    return [asset];
  },

  generate({asset}) {
    return {
      code: render(nullthrows(asset.ast).program)
    };
  }
});
