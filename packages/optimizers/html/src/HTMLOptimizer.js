// @flow strict-local
import {Optimizer} from '@parcel/plugin';
import {blobToBuffer} from '@parcel/utils';
import {optimizeHtml} from '@parcel/rust';
import path from 'path';

export default (new Optimizer({
  async loadConfig({config, options}) {
    let userConfig = await config.getConfigFrom(
      path.join(options.projectRoot, 'index.html'),
      [
        '.htmlnanorc',
        '.htmlnanorc.json',
        '.htmlnanorc.js',
        '.htmlnanorc.cjs',
        '.htmlnanorc.mjs',
        'htmlnano.config.js',
        'htmlnano.config.cjs',
        'htmlnano.config.mjs',
      ],
      {
        packageKey: 'htmlnano',
      },
    );

    let contents = userConfig?.contents;
    return contents;
  },
  async optimize({bundle, contents, map, config}) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map};
    }

    let code = await blobToBuffer(contents);
    let res = optimizeHtml({
      code,
      config,
    });

    return {
      contents: res.code,
    };
  },
}): Optimizer);
