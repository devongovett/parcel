// @flow strict-local
import type {PostHTMLNode} from 'posthtml';

import htmlnano from 'htmlnano';
import {
  md,
  generateJSONCodeHighlights,
  errorToDiagnostic,
} from '@parcel/diagnostic';
import {Optimizer} from '@parcel/plugin';
import {detectSVGOVersion} from '@parcel/utils';
import posthtml from 'posthtml';
import path from 'path';
import {SVG_ATTRS, SVG_TAG_NAMES} from './svgMappings';

export default (new Optimizer({
  async loadConfig({config, options, logger}) {
    let userConfig = await config.getConfigFrom(
      path.join(options.projectRoot, 'index.html'),
      [
        '.htmlnanorc',
        '.htmlnanorc.json',
        '.htmlnanorc.js',
        '.htmlnanorc.cjs',
        '.htmlnanorc.mjs',
        'htmlnano.config.js',
        'htmlnano.config.cjs',
        'htmlnano.config.mjs',
      ],
      {
        packageKey: 'htmlnano',
      },
    );

    let contents = userConfig?.contents;

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
    } else if (contents?.minifySvg) {
      // Otherwise try to detect the version based on the config file.
      let v = detectSVGOVersion(contents.minifySvg);
      if (userConfig != null && v.version === 2) {
        logger.warn({
          message: md`Detected deprecated SVGO v2 options in ${path.relative(
            process.cwd(),
            userConfig.filePath,
          )}`,
          codeFrames: [
            {
              filePath: userConfig.filePath,
              codeHighlights:
                path.basename(userConfig.filePath) === '.htmlnanorc' ||
                path.extname(userConfig.filePath) === '.json'
                  ? generateJSONCodeHighlights(
                      await options.inputFS.readFile(
                        userConfig.filePath,
                        'utf8',
                      ),
                      [
                        {
                          key: `${
                            path.basename(userConfig.filePath) ===
                            'package.json'
                              ? '/htmlnano'
                              : ''
                          }/minifySvg${v.path}`,
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

    return {
      contents,
      svgoVersion,
    };
  },
  async optimize({bundle, contents, map, config, options, logger}) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map};
    }

    if (typeof contents !== 'string') {
      throw new Error(
        'HTMLNanoOptimizer: Only string contents are currently supported',
      );
    }

    const clonedConfig = config.contents || {};

    // $FlowFixMe
    const presets = htmlnano.presets;
    const preset =
      typeof clonedConfig.preset === 'string'
        ? presets[clonedConfig.preset]
        : {};
    delete clonedConfig.preset;

    const htmlNanoConfig = {
      // Inline <script> and <style> elements, and style attributes are already
      // minified before they are re-inserted by the packager.
      minifyJs: false,
      minifyCss: false,
      ...(preset || {}),
      ...clonedConfig,
      // Never use htmlnano's builtin svgo transform.
      // We need to control the version of svgo that is used.
      minifySvg: false,
      // TODO: Uncomment this line once we update htmlnano, new version isn't out yet
      // skipConfigLoading: true,
    };

    let plugins = [htmlnano(htmlNanoConfig)];

    // $FlowFixMe
    if (clonedConfig.minifySvg !== false) {
      plugins.push(mapSVG);
      plugins.push(tree =>
        minifySvg(
          tree,
          options,
          config.svgoVersion,
          clonedConfig.minifySvg,
          logger,
        ),
      );
    }

    return {
      contents: (
        await posthtml(plugins).process(contents, {
          xmlMode: bundle.type === 'xhtml',
          closingSingleTag: bundle.type === 'xhtml' ? 'slash' : undefined,
        })
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

    // SVG in HTML does not require xml namespaces to be declared, but standalone SVG files do.
    // If unset, add them here so that SVGO doesn't have parse errors.
    if (tag === 'svg') {
      if (!attrs) {
        node.attrs = attrs = {};
      }

      if (!attrs.xmlns) {
        attrs.xmlns = 'http://www.w3.org/2000/svg';
      }

      if (!attrs['xmlns:xlink']) {
        attrs['xmlns:xlink'] = 'http://www.w3.org/1999/xlink';
      }
    }

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

async function minifySvg(tree, options, svgoVersion, svgoOptions, logger) {
  let svgNodes = [];
  tree.match({tag: 'svg'}, node => {
    svgNodes.push(node);
    return node;
  });

  if (!svgNodes.length) {
    return tree;
  }

  const svgo = await options.packageManager.require(
    'svgo',
    path.join(options.projectRoot, 'index'),
    {
      range: `^${svgoVersion}`,
      saveDev: true,
      shouldAutoInstall: options.shouldAutoInstall,
    },
  );

  let opts = svgoOptions;
  if (!svgoOptions) {
    let cleanupIds: string = svgoVersion === 2 ? 'cleanupIDs' : 'cleanupIds';
    opts = {
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              // Copied from htmlnano defaults.
              collapseGroups: false,
              convertShapeToPath: false,
              // Additional defaults to preserve accessibility information.
              removeTitle: false,
              removeDesc: false,
              removeUnknownsAndDefaults: {
                keepAriaAttrs: true,
                keepRoleAttr: true,
              },
              // Do not minify ids or remove unreferenced elements in
              // inline SVGs because they could actually be referenced
              // by a separate inline SVG.
              [cleanupIds]: false,
              removeHiddenElems: false,
            },
          },
        },
        // XML namespaces are not required in HTML.
        'removeXMLNS',
        'removeXlink',
      ],
    };
  }

  for (let node of svgNodes) {
    let svgStr = tree.render(node, {
      closingSingleTag: 'slash',
      quoteAllAttributes: true,
    });
    try {
      let result = svgo.optimize(svgStr, opts);
      node.tag = false;
      node.attrs = {};
      node.content = [result.data];
    } catch (error) {
      logger.warn(errorToDiagnostic(error));
    }
  }

  return tree;
}
