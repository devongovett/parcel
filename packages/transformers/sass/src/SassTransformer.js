// @flow
import {Transformer} from '@parcel/plugin';
import path from 'path';
import sass from 'sass';
import {transformLegacy} from './legacy';
import {transformModern} from './modern';

export default (new Transformer({
  async loadConfig({config, options}) {
    let configFile = await config.getConfig(
      ['.sassrc', '.sassrc.json', '.sassrc.js', '.sassrc.cjs', '.sassrc.mjs'],
      {
        packageKey: 'sass',
      },
    );

    let configResult = configFile ? configFile.contents : {};

    // Some packages in the wild declare a field `sass` in the package.json that
    // is a relative path to the sass entrypoint. In those cases we simply
    // initialize the config to an empty object.
    if (typeof configResult === 'string') {
      configResult = {};
    }

    let version = detectVersion(configResult);

    if (version === 'legacy') {
      // Resolve relative paths from config file
      if (configFile && configResult.includePaths) {
        configResult.includePaths = configResult.includePaths.map(p =>
          path.resolve(path.dirname(configFile.filePath), p),
        );
      }

      if (configResult.importer === undefined) {
        configResult.importer = [];
      } else if (!Array.isArray(configResult.importer)) {
        configResult.importer = [configResult.importer];
      }

      // Always emit sourcemap
      configResult.sourceMap = true;
      // sources are created relative to the directory of outFile
      configResult.outFile = path.join(options.projectRoot, 'style.css.map');
      configResult.omitSourceMapUrl = true;
      configResult.sourceMapContents = false;
    } else if (version === 'modern') {
      // Resolve relative paths from config file
      if (configFile && configResult.loadPaths) {
        configResult.loadPaths = configResult.loadPaths.map(p =>
          path.resolve(path.dirname(configFile.filePath), p),
        );
      }

      // Always emit sourcemap
      configResult.sourceMap = true;
    }

    return {version, config: configResult};
  },

  async transform({asset, options, config: {version, config}, resolve}) {
    if (version === 'legacy') {
      await transformLegacy(asset, config, resolve, options);
    } else {
      await transformModern(asset, config, resolve, options);
    }

    return [asset];
  },
}): Transformer);

function detectVersion(config: any) {
  if (!sass.compileStringAsync) {
    return 'legacy';
  }

  for (let legacyOption of [
    'data',
    'indentType',
    'indentWidth',
    'linefeed',
    'outputStyle',
    'importer',
    'pkgImporter',
    'includePaths',
    'omitSourceMapUrl',
    'outFile',
    'sourceMapContents',
    'sourceMapEmbed',
    'sourceMapRoot',
  ]) {
    if (config[legacyOption] != null) {
      return 'legacy';
    }
  }

  for (let modernOption of [
    'loadPaths',
    'sourceMapIncludeSources',
    'style',
    'importers',
  ]) {
    if (config[modernOption] != null) {
      return 'modern';
    }
  }

  if (typeof config.sourceMap === 'string') {
    return 'legacy';
  }

  if (
    config.functions &&
    typeof config.functions === 'object' &&
    Object.keys(config.functions).length > 0
  ) {
    for (let key in config.functions) {
      let fn = config.functions[key];
      if (typeof fn === 'function' && fn.length > 1) {
        return 'legacy';
      }
    }
  }

  return 'modern';
}
