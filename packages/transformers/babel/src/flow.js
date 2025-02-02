// @flow

import type {Config, PluginOptions, PackageJSON} from '@parcel/types';
import type {BabelConfig} from './types';
import typeof * as BabelCore from '@babel/core';

import {BABEL_CORE_RANGE} from './constants';
import path from 'path';

/**
 * Generates a babel config for stripping away Flow types.
 */
export default async function getFlowOptions(
  config: Config,
  options: PluginOptions,
): Promise<?BabelConfig> {
  if (!config.isSource) {
    return null;
  }

  // Only add flow plugin if `flow-bin` is listed as a dependency in the root package.json
  // @parcel/error-overlay package in integration tests is an exception
  if (
    !(
      process.env.PARCEL_BUILD_ENV === 'test' &&
      config.searchPath.includes('error-overlay')
    )
  ) {
    let conf = await config.getConfigFrom<PackageJSON>(
      options.projectRoot + '/index',
      ['package.json'],
    );
    let pkg = conf?.contents;
    if (
      !pkg ||
      (!(pkg.dependencies && pkg.dependencies['flow-bin']) &&
        !(pkg.devDependencies && pkg.devDependencies['flow-bin']))
    ) {
      return null;
    }
  }

  const babelCore: BabelCore = await options.packageManager.require(
    '@babel/core',
    config.searchPath,
    {
      range: BABEL_CORE_RANGE,
      saveDev: true,
      shouldAutoInstall: options.shouldAutoInstall,
    },
  );

  await options.packageManager.require(
    '@babel/plugin-transform-flow-strip-types',
    config.searchPath,
    {
      range: '^7.0.0',
      saveDev: true,
      shouldAutoInstall: options.shouldAutoInstall,
    },
  );

  return {
    plugins: [
      babelCore.createConfigItem(
        ['@babel/plugin-transform-flow-strip-types', {requireDirective: true}],
        {
          type: 'plugin',
          dirname: path.dirname(config.searchPath),
        },
      ),
    ],
  };
}
