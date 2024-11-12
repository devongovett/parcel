// @flow

import {Transformer} from '@parcel/plugin';

import jsxPlugin from '@svgr/plugin-jsx';
import {transform} from '@svgr/core';
import {detectSVGOVersion} from '@parcel/utils';
import path from 'path';
import {md, generateJSONCodeHighlights} from '@parcel/diagnostic';

export default (new Transformer({
  async loadConfig({config, logger, options}) {
    let svgrResult = await config.getConfig([
      '.svgrrc',
      '.svgrrc.json',
      '.svgrrc.js',
      '.svgrrc.cjs',
      '.svgrrc.mjs',
      'svgr.config.json',
      'svgr.config.js',
      'svgr.config.cjs',
      'svgr.config.mjs',
    ]);
    let svgoResult: any = await config.getConfig([
      'svgo.config.js',
      'svgo.config.cjs',
      'svgo.config.mjs',
      'svgo.config.json',
    ]);

    let svgoConfig = svgrResult?.contents?.svgoConfig ?? svgoResult?.contents;
    let svgoConfigPath = svgrResult?.contents?.svgoConfig
      ? svgrResult.filePath
      : svgoResult?.filePath;

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
    let svgoVersion = 3;
    if (resolved) {
      if (resolved.pkg?.version) {
        svgoVersion = parseInt(resolved.pkg.version);
      }
    } else if (svgoConfig) {
      // Otherwise try to detect the version based on the config file.
      let v = detectSVGOVersion(svgoConfig);
      if (svgoConfig != null && v.version === 2) {
        logger.warn({
          message: md`Detected deprecated SVGO v2 options in ${path.relative(
            process.cwd(),
            svgoConfigPath,
          )}`,
          codeFrames: [
            {
              filePath: svgoConfigPath,
              codeHighlights:
                path.basename(svgoConfigPath) === '.svgrrc' ||
                path.extname(svgoConfigPath) === '.json'
                  ? generateJSONCodeHighlights(
                      await options.inputFS.readFile(svgoConfigPath, 'utf8'),
                      [
                        {
                          key: `${
                            svgrResult?.contents?.svgoConfig
                              ? '/svgoConfig'
                              : ''
                          }${v.path}`,
                        },
                      ],
                    )
                  : [],
            },
          ],
        });
      }

      svgoVersion = v.version;
    }

    return {svgr: svgrResult?.contents, svgo: svgoConfig, svgoVersion};
  },

  async transform({asset, config, options}) {
    let code = await asset.getCode();

    let plugins = [];
    if (config.svgr?.svgo !== false) {
      let svgo = await options.packageManager.require(
        'svgo',
        path.join(options.projectRoot, 'index'),
        {
          range: `^${config.svgoVersion}`,
          saveDev: true,
          shouldAutoInstall: options.shouldAutoInstall,
        },
      );

      plugins.push(createSvgoPlugin(svgo));
    }

    plugins.push(jsxPlugin);

    const jsx = await transform(
      code,
      {svgoConfig: config.svgo, ...config.svgr, runtimeConfig: false},
      {
        caller: {
          name: '@parcel/transformer-svg-react',
          defaultPlugins: plugins,
        },
        filePath: asset.filePath,
      },
    );

    asset.type = config.svgr?.typescript ? 'tsx' : 'jsx';
    asset.bundleBehavior = null;
    asset.setCode(jsx);

    return [asset];
  },
}): Transformer);

// Below is copied from @svgr/plugin-svgo. MIT license.
// https://github.com/gregberge/svgr/tree/180eb6d503215fc782dfece351ff751194a0dfed/packages/plugin-svgo

function getSvgoConfigFromSvgrConfig(config) {
  const params = {overrides: {}};
  if (config.icon || config.dimensions === false) {
    params.overrides.removeViewBox = false;
  }
  if (config.native) {
    params.overrides.inlineStyles = {
      onlyMatchedOnce: false,
    };
  }

  return {
    plugins: [
      {
        name: 'preset-default',
        params,
      },
      'prefixIds',
    ],
  };
}

function getSvgoConfig(config) {
  if (config.svgoConfig) return config.svgoConfig;
  return getSvgoConfigFromSvgrConfig(config);
}

function createSvgoPlugin(svgo) {
  return (code, config, state) => {
    const svgoConfig = getSvgoConfig(config);
    const result = svgo.optimize(code, {...svgoConfig, path: state.filePath});

    // @ts-ignore
    if (result.modernError) {
      // @ts-ignore
      throw result.modernError;
    }

    return result.data;
  };
}
