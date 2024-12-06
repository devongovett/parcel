// @flow strict-local
import type {TransformerResult} from '@parcel/types';

import {Transformer} from '@parcel/plugin';
import nullthrows from 'nullthrows';
import {hashObject} from '@parcel/utils';
import ThrowableDiagnostic, {
  type Diagnostic,
  convertSourceLocationToHighlight,
  escapeMarkdown,
  md,
} from '@parcel/diagnostic';
import SourceMap from '@parcel/source-map';
import semver from 'semver';
import {basename, extname, relative, dirname} from 'path';
// $FlowFixMe
import * as compiler from '@vue/compiler-sfc';
// $FlowFixMe
import consolidate from '@ladjs/consolidate';

const MODULE_BY_NAME_RE = /\.module\./;

// TODO: Use language-specific config files during preprocessing
export default (new Transformer({
  async loadConfig({config}) {
    let conf = await config.getConfig(
      [
        '.vuerc',
        '.vuerc.json',
        '.vuerc.js',
        '.vuerc.cjs',
        '.vuerc.mjs',
        'vue.config.js',
        'vue.config.cjs',
        'vue.config.mjs',
      ],
      {packageKey: 'vue'},
    );
    let contents = {};
    if (conf) {
      config.invalidateOnStartup();
      contents = conf.contents;
      if (typeof contents !== 'object') {
        // TODO: codeframe
        throw new ThrowableDiagnostic({
          diagnostic: {
            message: 'Vue config should be an object.',
            origin: '@parcel/transformer-vue',
          },
        });
      }
    }
    return {
      customBlocks: contents.customBlocks || {},
      filePath: conf && conf.filePath,
      compilerOptions: contents.compilerOptions || {},
    };
  },
  canReuseAST({ast}) {
    return ast.type === 'vue' && semver.satisfies(ast.version, '^3.0.0');
  },
  async parse({asset, options}) {
    // TODO: This parses the vue component multiple times. Fix?
    let code = await asset.getCode();
    let parsed = compiler.parse(code, {
      sourceMap: true,
      filename: asset.filePath,
    });
    if (parsed.errors.length) {
      throw new ThrowableDiagnostic({
        diagnostic: parsed.errors.map(err => {
          return createDiagnostic(err, asset.filePath);
        }),
      });
    }

    const descriptor = parsed.descriptor;
    let id = hashObject({
      filePath: asset.filePath,
      source: options.mode === 'production' ? code : null,
    }).slice(-6);

    return {
      type: 'vue',
      version: '3.0.0',
      program: {
        ...descriptor,
        script:
          descriptor.script != null || descriptor.scriptSetup != null
            ? compiler.compileScript(descriptor, {
                id,
                isProd: options.mode === 'production',
              })
            : null,
        id,
      },
    };
  },
  async transform({asset, options, resolve, config}) {
    let {template, script, styles, customBlocks, id} = nullthrows(
      await asset.getAST(),
    ).program;
    let scopeId = 'data-v-' + id;
    let hmrId = id + '-hmr';
    let basePath = basename(asset.filePath);
    if (asset.pipeline != null) {
      return processPipeline({
        asset,
        template,
        script,
        styles,
        customBlocks,
        config,
        basePath,
        options,
        resolve,
        id,
        hmrId,
      });
    }
    return [
      {
        type: 'js',
        uniqueKey: asset.id + '-glue',
        content: `
let script;
let initialize = () => {
  script = ${
    script != null
      ? `require('script:./${basePath}');
  if (script.__esModule) script = script.default`
      : '{}'
  };
  ${
    template != null
      ? `script.render = require('template:./${basePath}').render;`
      : ''
  }
  ${
    styles.length !== 0
      ? `script.__cssModules = require('style:./${basePath}').default;`
      : ''
  }
  ${
    customBlocks != null
      ? `require('custom:./${basePath}').default(script);`
      : ''
  }
  script.__scopeId = '${scopeId}';
  script.__file = ${JSON.stringify(
    options.mode === 'production' ? basePath : asset.filePath,
  )};
};
initialize();
${
  options.hmrOptions
    ? `if (module.hot) {
  script.__hmrId = '${hmrId}';
  module.hot.accept(() => {
    setTimeout(() => {
      initialize();
      if (!__VUE_HMR_RUNTIME__.createRecord('${hmrId}', script)) {
        __VUE_HMR_RUNTIME__.reload('${hmrId}', script);
      }
    }, 0);
  });
}`
    : ''
}
export default script;`,
      },
    ];
  },
}): Transformer);

function createDiagnostic(err, filePath) {
  if (typeof err === 'string') {
    return {
      message: err,
      origin: '@parcel/transformer-vue',
      filePath,
    };
  }
  // TODO: codeframe
  let diagnostic: Diagnostic = {
    message: escapeMarkdown(err.message),
    origin: '@parcel/transformer-vue',
    name: err.name,
    stack: err.stack,
    codeFrames: err.loc
      ? [
          {
            filePath,
            codeHighlights: [convertSourceLocationToHighlight(err.loc)],
          },
        ]
      : [],
  };
  return diagnostic;
}

function getScriptType(script) {
  if (!script) {
    return 'js';
  }

  if (script.src) {
    script.lang = extname(script.src).slice(1);
  }
  let type;
  switch (script.lang || 'js') {
    case 'javascript':
    case 'js':
      type = 'js';
      break;
    case 'jsx':
      type = 'jsx';
      break;
    case 'typescript':
    case 'ts':
      type = 'ts';
      break;
    case 'tsx':
      type = 'tsx';
      break;
    case 'coffeescript':
    case 'coffee':
      type = 'coffee';
      break;
    default:
      // TODO: codeframe
      throw new ThrowableDiagnostic({
        diagnostic: {
          message: md`Unknown script language: "${script.lang}"`,
          origin: '@parcel/transformer-vue',
        },
      });
  }

  return type;
}

async function processPipeline({
  asset,
  template,
  script,
  styles,
  customBlocks,
  config,
  basePath,
  options,
  resolve,
  id,
  hmrId,
}) {
  switch (asset.pipeline) {
    case 'template': {
      let isFunctional = template.functional;
      if (template.src) {
        template.content = (
          await options.inputFS.readFile(
            await resolve(asset.filePath, template.src),
          )
        ).toString();
        template.lang = extname(template.src).slice(1);
      }
      let content = template.content;
      if (template.lang && !['htm', 'html'].includes(template.lang)) {
        let options = {};
        let preprocessor = consolidate[template.lang];
        // Pug doctype fix (fixes #7756)
        switch (template.lang) {
          case 'pug':
            options.doctype = 'html';
            break;
        }
        if (!preprocessor) {
          // TODO: codeframe
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: md`Unknown template language: "${template.lang}"`,
              origin: '@parcel/transformer-vue',
            },
          });
        }
        content = await preprocessor.render(content, options);
      }

      // if using TS, support TS syntax in template expressions
      const expressionPlugins = config.compilerOptions?.expressionPlugins || [];
      const type = getScriptType(script);
      if (type === 'ts') {
        expressionPlugins.push('typescript');
      }

      let templateComp = compiler.compileTemplate({
        filename: asset.filePath,
        source: content,
        inMap: template.src ? undefined : template.map,
        scoped: styles.some(style => style.scoped),
        isFunctional,
        compilerOptions: {
          ...config.compilerOptions,
          bindingMetadata: script ? script.bindings : undefined,
          expressionPlugins,
        },
        isProd: options.mode === 'production',
        id,
      });
      if (templateComp.errors.length) {
        throw new ThrowableDiagnostic({
          diagnostic: templateComp.errors.map(err => {
            return createDiagnostic(err, asset.filePath);
          }),
        });
      }
      let templateAsset: TransformerResult = {
        type,
        uniqueKey: asset.id + '-template',
        ...(!template.src &&
          asset.env.sourceMap && {
            map: createMap(templateComp.map, options.projectRoot),
          }),
        content:
          templateComp.code +
          `
${
  options.hmrOptions
    ? `if (module.hot) {
  module.hot.accept(() => {
    __VUE_HMR_RUNTIME__.rerender('${hmrId}', render);
  })
}`
    : ''
}`,
      };
      return [templateAsset];
    }
    case 'script': {
      if (script.src) {
        script.content = (
          await options.inputFS.readFile(
            await resolve(asset.filePath, script.src),
          )
        ).toString();
        script.lang = extname(script.src).slice(1);
      }
      let type = getScriptType(script);
      let scriptAsset = {
        type,
        uniqueKey: asset.id + '-script',
        content: script.content,
        ...(!script.src &&
          asset.env.sourceMap && {
            map: createMap(script.map, options.projectRoot),
          }),
      };

      return [scriptAsset];
    }
    case 'style': {
      let cssModules = {};
      let assets = await Promise.all(
        styles.map(async (style, i) => {
          if (style.src) {
            style.content = (
              await options.inputFS.readFile(
                await resolve(asset.filePath, style.src),
              )
            ).toString();
            if (!style.module) {
              style.module = MODULE_BY_NAME_RE.test(style.src);
            }
            style.lang = extname(style.src).slice(1);
          }
          switch (style.lang) {
            case 'less':
            case 'stylus':
            case 'styl':
            case 'scss':
            case 'sass':
            case 'css':
            case undefined:
              break;
            default:
              // TODO: codeframe
              throw new ThrowableDiagnostic({
                diagnostic: {
                  message: md`Unknown style language: "${style.lang}"`,
                  origin: '@parcel/transformer-vue',
                },
              });
          }
          let styleComp = await compiler.compileStyleAsync({
            filename: asset.filePath,
            source: style.content,
            modules: style.module,
            preprocessLang: style.lang || 'css',
            scoped: style.scoped,
            inMap: style.src ? undefined : style.map,
            isProd: options.mode === 'production',
            id,
          });
          if (styleComp.errors.length) {
            throw new ThrowableDiagnostic({
              diagnostic: styleComp.errors.map(err => {
                return createDiagnostic(err, asset.filePath);
              }),
            });
          }
          let styleAsset = {
            type: 'css',
            content: styleComp.code,
            sideEffects: true,
            ...(!style.src &&
              asset.env.sourceMap && {
                map: createMap(style.map, options.projectRoot),
              }),
            uniqueKey: asset.id + '-style' + i,
          };
          if (styleComp.modules) {
            if (typeof style.module === 'boolean') style.module = '$style';
            cssModules[style.module] = {
              ...cssModules[style.module],
              ...styleComp.modules,
            };
          }
          return styleAsset;
        }),
      );
      if (Object.keys(cssModules).length !== 0) {
        assets.push({
          type: 'js',
          uniqueKey: asset.id + '-cssModules',
          content: `
import {render} from 'template:./${basePath}';
let cssModules = ${JSON.stringify(cssModules)};
${
  options.hmrOptions
    ? `if (module.hot) {
  module.hot.accept(() => {
    __VUE_HMR_RUNTIME__.rerender('${hmrId}', render);
  });
};`
    : ''
}
export default cssModules;`,
        });
      }
      return assets;
    }
    case 'custom': {
      let toCall = [];
      // To satisfy flow
      if (!config) return [];
      let types = new Set();
      for (let block of customBlocks) {
        let {type, src, content, attrs} = block;
        if (!config.customBlocks[type]) {
          // TODO: codeframe
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: md`No preprocessor found for block type ${type}`,
              origin: '@parcel/transformer-vue',
            },
          });
        }
        if (src) {
          content = (
            await options.inputFS.readFile(await resolve(asset.filePath, src))
          ).toString();
        }
        toCall.push([type, content, attrs]);
        types.add(type);
      }
      return [
        {
          type: 'js',
          uniqueKey: asset.id + '-custom',
          content: `
let NOOP = () => {};
${(
  await Promise.all(
    [...types].map(
      async type =>
        `import p${type} from './${relative(
          dirname(asset.filePath),
          await resolve(nullthrows(config.filePath), config.customBlocks[type]),
        )}';
if (typeof p${type} !== 'function') {
  p${type} = NOOP;
}`,
    ),
  )
).join('\n')}
export default script => {
  ${toCall
    .map(
      ([type, content, attrs]) =>
        `  p${type}(script, ${JSON.stringify(content)}, ${JSON.stringify(
          attrs,
        )});`,
    )
    .join('\n')}
}`,
        },
      ];
    }
    default: {
      return [];
    }
  }
}

function createMap(rawMap, projectRoot: string) {
  let newMap = new SourceMap(projectRoot);
  newMap.addVLQMap(rawMap);
  return newMap;
}
