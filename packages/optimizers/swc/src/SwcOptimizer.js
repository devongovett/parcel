// @flow

import nullthrows from 'nullthrows';
import {transform} from '@swc/core';
import {Optimizer} from '@parcel/plugin';
import {blobToString, stripAnsi} from '@parcel/utils';
import SourceMap from '@parcel/source-map';
import ThrowableDiagnostic, {escapeMarkdown} from '@parcel/diagnostic';
import path from 'path';

export default (new Optimizer({
  async loadConfig({config, options}) {
    let userConfig = await config.getConfigFrom(
      path.join(options.projectRoot, 'index'),
      ['.terserrc', '.terserrc.js', '.terserrc.cjs', '.terserrc.mjs'],
    );

    return userConfig?.contents;
  },
  async optimize({
    contents,
    map: originalMap,
    bundle,
    config: userConfig,
    options,
    getSourceMapReference,
  }) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map: originalMap};
    }

    let code = await blobToString(contents);
    let result;
    try {
      result = await transform(code, {
        jsc: {
          target: 'es2022',
          minify: {
            mangle: true,
            compress: true,
            ...userConfig,
            toplevel:
              bundle.env.outputFormat === 'esmodule' ||
              bundle.env.outputFormat === 'commonjs',
            module: bundle.env.outputFormat === 'esmodule',
          },
        },
        isModule: bundle.env.outputFormat === 'esmodule',
        minify: true,
        sourceMaps: !!bundle.env.sourceMap,
        configFile: false,
        swcrc: false,
      });
    } catch (err) {
      // SWC doesn't give us nice error objects, so we need to parse the message.
      let message = escapeMarkdown(
        (
          stripAnsi(err.message)
            .split('\n')
            .find(line => line.trim().length > 0) || ''
        )
          .trim()
          .replace(/^(×|x)\s+/, ''),
      );
      let location = err.message.match(/(?:╭─|,-)\[(\d+):(\d+)\]/);
      if (location) {
        let line = Number(location[1]);
        let col = Number(location[1]);
        let mapping = originalMap?.findClosestMapping(line, col);
        if (mapping && mapping.original && mapping.source) {
          let {source, original} = mapping;
          let filePath = path.resolve(options.projectRoot, source);
          throw new ThrowableDiagnostic({
            diagnostic: {
              message,
              origin: '@parcel/optimizer-swc',
              codeFrames: [
                {
                  language: 'js',
                  filePath,
                  codeHighlights: [{start: original, end: original}],
                },
              ],
            },
          });
        }

        let loc = {
          line: line,
          column: col,
        };

        throw new ThrowableDiagnostic({
          diagnostic: {
            message,
            origin: '@parcel/optimizer-swc',
            codeFrames: [
              {
                language: 'js',
                filePath: undefined,
                code,
                codeHighlights: [{start: loc, end: loc}],
              },
            ],
          },
        });
      }

      throw err;
    }

    let sourceMap = null;
    let minifiedContents: string = nullthrows(result.code);
    let resultMap = result.map;
    if (resultMap) {
      sourceMap = new SourceMap(options.projectRoot);
      sourceMap.addVLQMap(JSON.parse(resultMap));
      if (originalMap) {
        sourceMap.extends(originalMap);
      }
      let sourcemapReference = await getSourceMapReference(sourceMap);
      if (sourcemapReference) {
        minifiedContents += `\n//# sourceMappingURL=${sourcemapReference}\n`;
      }
    }

    return {contents: minifiedContents, map: sourceMap};
  },
}): Optimizer);
