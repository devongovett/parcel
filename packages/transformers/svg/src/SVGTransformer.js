// @flow

import {Transformer} from '@parcel/plugin';
import ThrowableDiagnostic from '@parcel/diagnostic';
import {transformSvg} from '@parcel/rust';

const TYPES = {
  'application/javascript': 'js',
  'application/ecmascript': 'js',
  'text/javascript': 'js',
  'application/json': false,
  'application/ld+json': 'jsonld',
  'text/html': false,
  module: 'js',
};

export default (new Transformer({
  async transform({asset}) {
    asset.bundleBehavior = 'isolated';

    let res = transformSvg({
      code: await asset.getBuffer(),
      scope_hoist: asset.env.shouldScopeHoist,
      supports_esm: false,
      hmr: false,
    });

    if (res.errors.length) {
      throw new ThrowableDiagnostic({
        diagnostic: res.errors.map(error => ({
          message: error.message,
          origin: '@parcel/transformer-svg',
          codeFrames: [
            {
              filePath: asset.filePath,
              language: 'svg',
              codeHighlights: [
                {
                  start: {
                    line: error.line,
                    column: 1,
                  },
                  end: {
                    line: error.line,
                    column: 1,
                  },
                },
              ],
            },
          ],
        })),
      });
    }

    asset.setBuffer(res.code);

    let assets = [asset];
    for (let dep of res.dependencies) {
      asset.addURLDependency(dep.href, {
        priority: dep.priority,
        needsStableName: dep.needsStableName,
        bundleBehavior:
          dep.bundleBehavior === 'none' ? undefined : dep.bundleBehavior,
        env: convertEnv(asset, dep),
        meta: {
          placeholder: dep.placeholder,
        },
      });
    }

    for (let a of res.assets) {
      assets.push({
        type: TYPES[a.type] || a.type.split('/')[1] || a.type,
        content: a.content,
        uniqueKey: a.key,
        env: convertEnv(asset, a),
        meta: {
          type: a.isAttr ? 'attr' : 'tag',
          startLine: a.line,
        },
      });
    }

    return assets;
  },
}): Transformer);

function convertEnv(asset, dep) {
  return {
    outputFormat: dep.outputFormat === 'none' ? undefined : dep.outputFormat,
    sourceType: dep.sourceType === 'none' ? undefined : dep.sourceType,
    loc:
      dep.outputFormat !== 'none' || dep.sourceType !== 'none'
        ? {
            filePath: asset.filePath,
            start: {
              line: dep.line,
              column: 1,
            },
            end: {
              line: dep.line,
              column: 2,
            },
          }
        : undefined,
  };
}
