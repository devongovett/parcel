// @flow strict-local
import type {PostHTMLNode} from 'posthtml';

import htmlnano from 'htmlnano';
import {
  md,
  generateJSONCodeHighlights,
  errorToDiagnostic,
} from '@parcel/diagnostic';
import {Optimizer} from '@parcel/plugin';
import {blobToBuffer} from '@parcel/utils';
import {optimizeHtml} from '@parcel/rust';

export default (new Optimizer({
  // async loadConfig({config, options, logger}) {
  //   let userConfig = await config.getConfigFrom(
  //     path.join(options.projectRoot, 'index.html'),
  //     [
  //       '.htmlnanorc',
  //       '.htmlnanorc.json',
  //       '.htmlnanorc.js',
  //       '.htmlnanorc.cjs',
  //       '.htmlnanorc.mjs',
  //       'htmlnano.config.js',
  //       'htmlnano.config.cjs',
  //       'htmlnano.config.mjs',
  //     ],
  //     {
  //       packageKey: 'htmlnano',
  //     },
  //   );

  //   let contents = userConfig?.contents;

  //   // See if svgo is already installed.
  //   let resolved;
  //   try {
  //     resolved = await options.packageManager.resolve(
  //       'svgo',
  //       path.join(options.projectRoot, 'index'),
  //       {shouldAutoInstall: false},
  //     );
  //   } catch (err) {
  //     // ignore.
  //   }

  //   // If so, use the existing installed version.
  //   let svgoVersion = 3;
  //   if (resolved) {
  //     if (resolved.pkg?.version) {
  //       svgoVersion = parseInt(resolved.pkg.version);
  //     }
  //   } else if (contents?.minifySvg) {
  //     // Otherwise try to detect the version based on the config file.
  //     let v = detectSVGOVersion(contents.minifySvg);
  //     if (userConfig != null && v.version === 2) {
  //       logger.warn({
  //         message: md`Detected deprecated SVGO v2 options in ${path.relative(
  //           process.cwd(),
  //           userConfig.filePath,
  //         )}`,
  //         codeFrames: [
  //           {
  //             filePath: userConfig.filePath,
  //             codeHighlights:
  //               path.basename(userConfig.filePath) === '.htmlnanorc' ||
  //               path.extname(userConfig.filePath) === '.json'
  //                 ? generateJSONCodeHighlights(
  //                     await options.inputFS.readFile(
  //                       userConfig.filePath,
  //                       'utf8',
  //                     ),
  //                     [
  //                       {
  //                         key: `${
  //                           path.basename(userConfig.filePath) ===
  //                           'package.json'
  //                             ? '/htmlnano'
  //                             : ''
  //                         }/minifySvg${v.path}`,
  //                       },
  //                     ],
  //                   )
  //                 : [],
  //           },
  //         ],
  //       });
  //     }

  //     svgoVersion = v.version;
  //   }

  //   return {
  //     contents,
  //     svgoVersion,
  //   };
  // },
  async optimize({bundle, contents, map, config, options, logger}) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map};
    }

    let code = await blobToBuffer(contents);
    let res = optimizeHtml({
      code
    });

    return {
      contents: res.code,
    };
  },
}): Optimizer);
