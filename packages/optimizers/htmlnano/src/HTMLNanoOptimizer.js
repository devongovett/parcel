// @flow strict-local
import type {PostHTMLNode} from 'posthtml';

import htmlnano from 'htmlnano';
import {Optimizer} from '@parcel/plugin';
import posthtml from 'posthtml';
import path from 'path';
import {SVG_ATTRS, SVG_TAG_NAMES} from './svgMappings';
// $FlowFixMe
import {extendDefaultPlugins} from 'svgo';

export default (new Optimizer({
  async loadConfig({config, options}) {
    let userConfig = await config.getConfigFrom(
      path.join(options.entryRoot, 'index.html'),
      ['.htmlnanorc', '.htmlnanorc.js'],
    );

    if (userConfig) {
      let isJavascript = path.extname(userConfig.filePath) === '.js';
      if (isJavascript) {
        config.invalidateOnStartup();
      }
    }

    return userConfig?.contents;
  },
  async optimize({bundle, contents, map, config}) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map};
    }

    if (typeof contents !== 'string') {
      throw new Error(
        'HTMLNanoOptimizer: Only string contents are currently supported',
      );
    }

    const htmlNanoConfig = {
      minifyJs: false,
      minifySvg: {
        plugins: extendDefaultPlugins([
          // Copied from htmlnano defaults.
          {
            name: 'collapseGroups',
            active: false,
          },
          {
            name: 'convertShapeToPath',
            active: false,
          },
          // Additional defaults to preserve accessibility information.
          {
            name: 'removeTitle',
            active: false,
          },
          {
            name: 'removeDesc',
            active: false,
          },
          {
            name: 'removeUnknownsAndDefaults',
            params: {
              keepAriaAttrs: true,
              keepRoleAttr: true,
            },
          },
        ]),
      },
      ...config,
    };

    return {
      contents: (
        await posthtml([mapSVG, htmlnano(htmlNanoConfig)]).process(contents)
      ).html,
    };
  },
}): Optimizer);

// HTML tags and attributes are case insensitive. The HTML transformer normalizes them so it can
// more easily process any case. But SVGO requires case sensitive tags and attributes to work correctly.
// So map lowercased tag and attribute names back to their case-sensitive equivalents.
function mapSVG(
  node: string | PostHTMLNode | Array<string | PostHTMLNode>,
  inSVG = false,
) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      // $FlowFixMe
      node[i] = mapSVG(node[i], inSVG);
    }
  } else if (node && typeof node === 'object') {
    let {tag, attrs} = node;
    if (inSVG || tag === 'svg') {
      if (SVG_TAG_NAMES[tag]) {
        node.tag = SVG_TAG_NAMES[tag];
      }

      if (attrs) {
        for (let key in attrs) {
          if (SVG_ATTRS[key]) {
            attrs[SVG_ATTRS[key]] = attrs[key];
            delete attrs[key];
          }
        }
      }
    }

    if (node.content != null) {
      mapSVG(node.content, inSVG || tag === 'svg');
    }
  }

  return node;
}
