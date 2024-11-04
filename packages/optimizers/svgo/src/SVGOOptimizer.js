// @flow

import {Optimizer} from '@parcel/plugin';
import ThrowableDiagnostic, {
  errorToDiagnostic,
  md,
  generateJSONCodeHighlights,
} from '@parcel/diagnostic';
import {blobToString, detectSVGOVersion} from '@parcel/utils';
import path from 'path';

export default (new Optimizer({
  async loadConfig({config, logger, options}) {
    let configFile = await config.getConfig([
      'svgo.config.js',
      'svgo.config.cjs',
      'svgo.config.mjs',
      'svgo.config.json',
    ]);

    // See if svgo is already installed.
    let resolved;
    try {
      resolved = await options.packageManager.resolve(
        'svgo',
        path.join(options.projectRoot, 'index'),
        {shouldAutoInstall: false},
      );
    } catch (err) {
      // ignore.
    }

    // If so, use the existing installed version.
    let version = 3;
    if (resolved) {
      if (resolved.pkg?.version) {
        version = parseInt(resolved.pkg.version);
      }
    } else {
      // Otherwise try to detect the version based on the config file.
      let v = detectSVGOVersion(configFile?.contents);
      if (configFile != null && v.version === 2) {
        logger.warn({
          message: md`Detected deprecated SVGO v2 options in ${path.relative(
            process.cwd(),
            configFile.filePath,
          )}`,
          codeFrames: [
            {
              filePath: configFile.filePath,
              codeHighlights:
                path.extname(configFile.filePath) === '.json'
                  ? generateJSONCodeHighlights(
                      await options.inputFS.readFile(
                        configFile.filePath,
                        'utf8',
                      ),
                      [{key: v.path}],
                    )
                  : [],
            },
          ],
        });
      }

      version = v.version;
    }

    return {
      contents: configFile?.contents,
      version,
    };
  },

  async optimize({bundle, contents, config, options}) {
    if (!bundle.env.shouldOptimize) {
      return {contents};
    }

    const svgo = await options.packageManager.require(
      'svgo',
      path.join(options.projectRoot, 'index'),
      {
        range: `^${config.version}`,
        saveDev: true,
        shouldAutoInstall: options.shouldAutoInstall,
      },
    );

    let code = await blobToString(contents);
    let cleanupIds: string = config.version === 2 ? 'cleanupIDs' : 'cleanupIds';
    let result;
    try {
      result = svgo.optimize(code, {
        plugins: [
          {
            name: 'preset-default',
            params: {
              overrides: {
                // Removing ids could break SVG sprites.
                [cleanupIds]: false,
                // <style> elements and attributes are already minified before they
                // are re-inserted by the packager.
                minifyStyles: false,
              },
            },
          },
        ],
        ...config.contents,
      });
    } catch (err) {
      throw errorToDiagnostic(err);
    }

    // For svgo v2.
    if (result.error != null) {
      throw new ThrowableDiagnostic({
        diagnostic: {
          message: result.error,
        },
      });
    }

    return {contents: result.data};
  },
}): Optimizer);
