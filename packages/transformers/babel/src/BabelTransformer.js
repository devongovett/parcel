// @flow strict-local

import {babelErrorEnhancer} from './babelErrorUtils';
import {Transformer} from '@parcel/plugin';
import {relativeUrl} from '@parcel/utils';
import SourceMap from '@parcel/source-map';
import semver from 'semver';
import babel7 from './babel7';
import {load} from './config';

export default (new Transformer({
  loadConfig({config, options, logger}) {
    return load(config, options, logger);
  },

  canReuseAST({ast}) {
    return ast.type === 'babel' && semver.satisfies(ast.version, '^7.0.0');
  },

  async transform({asset, config, logger, options, tracer}) {
    try {
      if (config?.config) {
        if (
          asset.meta.babelPlugins != null &&
          Array.isArray(asset.meta.babelPlugins)
        ) {
          await babel7({
            asset,
            options,
            logger,
            babelOptions: config,
            additionalPlugins: asset.meta.babelPlugins,
            tracer,
          });
        } else {
          await babel7({
            asset,
            options,
            logger,
            babelOptions: config,
            tracer,
          });
        }
      }

      return [asset];
    } catch (e) {
      throw await babelErrorEnhancer(e, asset);
    }
  },

  async generate({asset, ast, options}) {
    let originalSourceMap = await asset.getMap();
    let sourceFileName: string = relativeUrl(
      options.projectRoot,
      asset.filePath,
    );

    const babelCorePath = await options.packageManager.resolve(
      '@babel/core',
      asset.filePath,
      {
        range: '^7.12.0',
        saveDev: true,
        shouldAutoInstall: options.shouldAutoInstall,
      },
    );

    const {default: generate} = await options.packageManager.require(
      '@babel/generator',
      babelCorePath.resolved,
    );

    let {code, rawMappings} = generate(ast.program, {
      sourceFileName,
      sourceMaps: !!asset.env.sourceMap,
      comments: true,
      importAttributesKeyword: 'with',
    });

    let map = new SourceMap(options.projectRoot);
    if (rawMappings) {
      map.addIndexedMappings(rawMappings);
    }

    if (originalSourceMap) {
      // The babel AST already contains the correct mappings, but not the source contents.
      // We need to copy over the source contents from the original map.
      let sourcesContent = originalSourceMap.getSourcesContentMap();
      for (let filePath in sourcesContent) {
        let content = sourcesContent[filePath];
        if (content != null) {
          map.setSourceContent(filePath, content);
        }
      }
    }

    return {
      content: code,
      map,
    };
  },
}): Transformer);
