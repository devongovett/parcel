// @flow

import {Transformer} from '@parcel/plugin';
import path from 'path';
import os from 'os';

export default new Transformer({
  async transform({asset, options}) {
    asset.type = 'js';

    // require kotlin
    const kotlinCompiler = await options.packageManager.require(
      '@jetbrains/kotlinc-js-api',
      asset.filePath
    );

    let id = Math.random()
      .toString(36)
      .slice(3);
    let dir = path.join(os.tmpdir(), id);
    let filename = path.join(dir, id + '.js');

    await asset.fs.mkdirp(dir);

    await kotlinCompiler.compile({
      output: filename,
      sources: [asset.filePath],
      moduleKind: 'commonjs',
      noStdlib: false,
      metaInfo: true,
      sourceMaps: options.sourceMaps
    });

    let code = await asset.fs.readFile(filename, 'utf8');

    if (options.sourceMaps) {
      let sourceMap = await asset.fs.readFile(filename + '.map', 'utf8');

      sourceMap = JSON.parse(sourceMap);
      sourceMap.sources = [this.relativeName];
      sourceMap.sourcesContent = [this.contents];

      asset.setMap(sourceMap);

      // remove source map url
      code = code.substring(0, code.lastIndexOf('//# sourceMappingURL'));
    }

    asset.setCode(code);

    // delete temp directory
    await asset.fs.rimraf(dir);

    return [asset];
  }
});
