// @flow
import type {
  JSONObject,
  EnvMap,
  SourceLocation,
  FilePath,
  FileCreateInvalidation,
} from '@parcel/types';
import type {SchemaEntity} from '@parcel/utils';
import type {Diagnostic} from '@parcel/diagnostic';
import SourceMap from '@parcel/source-map';
import {Transformer} from '@parcel/plugin';
import {transform, transformAsync} from '@parcel/rust';
import browserslist from 'browserslist';
import semver from 'semver';
import nullthrows from 'nullthrows';
import invariant from 'assert';
import ThrowableDiagnostic, {
  encodeJSONKeyComponent,
  convertSourceLocationToHighlight,
} from '@parcel/diagnostic';
import {validateSchema, remapSourceLocation, globMatch} from '@parcel/utils';
import pkg from '../package.json';

const JSX_EXTENSIONS = {
  jsx: true,
  tsx: true,
};

const JSX_PRAGMA = {
  react: {
    pragma: 'React.createElement',
    pragmaFrag: 'React.Fragment',
    automatic: '>= 17.0.0 || ^16.14.0 || >= 0.0.0-0 < 0.0.0',
  },
  preact: {
    pragma: 'h',
    pragmaFrag: 'Fragment',
    automatic: '>= 10.5.0',
  },
  nervjs: {
    pragma: 'Nerv.createElement',
    pragmaFrag: undefined,
    automatic: undefined,
  },
  hyperapp: {
    pragma: 'h',
    pragmaFrag: undefined,
    automatic: undefined,
  },
};

const BROWSER_MAPPING = {
  and_chr: 'chrome',
  and_ff: 'firefox',
  ie_mob: 'ie',
  ios_saf: 'ios',
  op_mob: 'opera',
  and_qq: null,
  and_uc: null,
  baidu: null,
  bb: null,
  kaios: null,
  op_mini: null,
};

// List of browsers to exclude when the esmodule target is specified.
// Based on https://caniuse.com/#feat=es6-module
const ESMODULE_BROWSERS = [
  'not ie <= 11',
  'not edge < 16',
  'not firefox < 60',
  'not chrome < 61',
  'not safari < 11',
  'not opera < 48',
  'not ios_saf < 11',
  'not op_mini all',
  'not android < 76',
  'not blackberry > 0',
  'not op_mob > 0',
  'not and_chr < 76',
  'not and_ff < 68',
  'not ie_mob > 0',
  'not and_uc > 0',
  'not samsung < 8.2',
  'not and_qq > 0',
  'not baidu > 0',
  'not kaios > 0',
];

const CONFIG_SCHEMA: SchemaEntity = {
  type: 'object',
  properties: {
    inlineFS: {
      type: 'boolean',
    },
    inlineEnvironment: {
      oneOf: [
        {
          type: 'boolean',
        },
        {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      ],
    },
    unstable_inlineConstants: {
      type: 'boolean',
    },
  },
  additionalProperties: false,
};

const SCRIPT_ERRORS = {
  browser: {
    message: 'Browser scripts cannot have imports or exports.',
    hint: 'Add the type="module" attribute to the <script> tag.',
  },
  'web-worker': {
    message:
      'Web workers cannot have imports or exports without the `type: "module"` option.',
    hint: "Add {type: 'module'} as a second argument to the Worker constructor.",
  },
  'service-worker': {
    message:
      'Service workers cannot have imports or exports without the `type: "module"` option.',
    hint: "Add {type: 'module'} as a second argument to the navigator.serviceWorker.register() call.",
  },
};

const OPTIONAL = 1 << 0;
const HELPER = 1 << 1;
const NEEDS_STABLE_NAME = 1 << 2;
const REACT_LAZY = 1 << 3;

type TSConfig = {
  compilerOptions?: {
    // https://www.typescriptlang.org/tsconfig#jsx
    jsx?: 'react' | 'react-jsx' | 'react-jsxdev' | 'preserve' | 'react-native',
    // https://www.typescriptlang.org/tsconfig#jsxFactory
    jsxFactory?: string,
    // https://www.typescriptlang.org/tsconfig#jsxFragmentFactory
    jsxFragmentFactory?: string,
    // https://www.typescriptlang.org/tsconfig#jsxImportSource
    jsxImportSource?: string,
    // https://www.typescriptlang.org/tsconfig#experimentalDecorators
    experimentalDecorators?: boolean,
    // https://www.typescriptlang.org/tsconfig#useDefineForClassFields
    useDefineForClassFields?: boolean,
    // https://www.typescriptlang.org/tsconfig#target
    target?: string, // 'es3' | 'es5' | 'es6' | 'es2015' | ...  |'es2022' | ... | 'esnext'
    ...
  },
  ...
};

type MacroAsset = {|
  type: string,
  content: string,
|};

// NOTE: Make sure this is in sync with the TypeScript definition in the @parcel/macros package.
type MacroContext = {|
  addAsset(asset: MacroAsset): void,
  invalidateOnFileChange(FilePath): void,
  invalidateOnFileCreate(FileCreateInvalidation): void,
  invalidateOnEnvChange(string): void,
  invalidateOnStartup(): void,
  invalidateOnBuild(): void,
|};

export default (new Transformer({
  async loadConfig({config, options}) {
    let pkg = await config.getPackage();
    let isJSX,
      pragma,
      pragmaFrag,
      jsxImportSource,
      automaticJSXRuntime,
      reactRefresh,
      decorators,
      useDefineForClassFields;
    if (config.isSource) {
      let reactLib;
      if (pkg?.alias && pkg.alias['react']) {
        // e.g.: `{ alias: { "react": "preact/compat" } }`
        reactLib = 'react';
      } else {
        // Find a dependency that we can map to a JSX pragma
        reactLib = Object.keys(JSX_PRAGMA).find(
          libName =>
            pkg?.dependencies?.[libName] ||
            pkg?.devDependencies?.[libName] ||
            pkg?.peerDependencies?.[libName],
        );
      }

      reactRefresh =
        options.hmrOptions &&
        options.mode === 'development' &&
        Boolean(
          pkg?.dependencies?.react ||
            pkg?.devDependencies?.react ||
            pkg?.peerDependencies?.react,
        );

      let tsconfig = await config.getConfigFrom<TSConfig>(
        options.projectRoot + '/index',
        ['tsconfig.json', 'jsconfig.json'],
      );
      let compilerOptions = tsconfig?.contents?.compilerOptions;

      // Use explicitly defined JSX options in tsconfig.json over inferred values from dependencies.
      pragma =
        compilerOptions?.jsxFactory ||
        (reactLib ? JSX_PRAGMA[reactLib].pragma : undefined);
      pragmaFrag =
        compilerOptions?.jsxFragmentFactory ||
        (reactLib ? JSX_PRAGMA[reactLib].pragmaFrag : undefined);

      if (
        compilerOptions?.jsx === 'react-jsx' ||
        compilerOptions?.jsx === 'react-jsxdev' ||
        compilerOptions?.jsxImportSource
      ) {
        jsxImportSource = compilerOptions?.jsxImportSource;
        automaticJSXRuntime = true;
      } else if (reactLib) {
        let effectiveReactLib =
          pkg?.alias && pkg.alias['react'] === 'preact/compat'
            ? 'preact'
            : reactLib;
        let automaticVersion = JSX_PRAGMA[effectiveReactLib]?.automatic;
        let reactLibVersion =
          pkg?.dependencies?.[effectiveReactLib] ||
          pkg?.devDependencies?.[effectiveReactLib] ||
          pkg?.peerDependencies?.[effectiveReactLib];
        reactLibVersion = reactLibVersion
          ? semver.validRange(reactLibVersion)
          : null;
        let minReactLibVersion =
          reactLibVersion !== null && reactLibVersion !== '*'
            ? semver.minVersion(reactLibVersion)?.toString()
            : null;

        automaticJSXRuntime =
          automaticVersion &&
          !compilerOptions?.jsxFactory &&
          minReactLibVersion != null &&
          semver.satisfies(minReactLibVersion, automaticVersion, {
            includePrerelease: true,
          });

        if (automaticJSXRuntime) {
          jsxImportSource = reactLib;
        }
      }

      isJSX = Boolean(compilerOptions?.jsx || pragma);
      decorators = compilerOptions?.experimentalDecorators;
      useDefineForClassFields = compilerOptions?.useDefineForClassFields;
      if (
        useDefineForClassFields === undefined &&
        compilerOptions?.target != null
      ) {
        // Default useDefineForClassFields to true if target is ES2022 or higher (including ESNext)
        let target = compilerOptions.target.slice(2);
        if (target === 'next') {
          useDefineForClassFields = true;
        } else {
          useDefineForClassFields = Number(target) >= 2022;
        }
      }
    }

    // Check if we should ignore fs calls
    // See https://github.com/defunctzombie/node-browser-resolve#skip
    let ignoreFS =
      pkg &&
      pkg.browser &&
      typeof pkg.browser === 'object' &&
      pkg.browser.fs === false;

    let conf = await config.getConfigFrom(options.projectRoot + '/index', [], {
      packageKey: '@parcel/transformer-js',
    });

    let inlineEnvironment = config.isSource;
    let inlineFS = !ignoreFS;
    let inlineConstants = false;
    if (conf && conf.contents) {
      validateSchema.diagnostic(
        CONFIG_SCHEMA,
        {
          data: conf.contents,
          // FIXME
          source: await options.inputFS.readFile(conf.filePath, 'utf8'),
          filePath: conf.filePath,
          prependKey: `/${encodeJSONKeyComponent('@parcel/transformer-js')}`,
        },
        // FIXME
        '@parcel/transformer-js',
        'Invalid config for @parcel/transformer-js',
      );

      inlineEnvironment = conf.contents?.inlineEnvironment ?? inlineEnvironment;
      inlineFS = conf.contents?.inlineFS ?? inlineFS;
      inlineConstants =
        conf.contents?.unstable_inlineConstants ?? inlineConstants;
    }

    return {
      isJSX,
      automaticJSXRuntime,
      jsxImportSource,
      pragma,
      pragmaFrag,
      inlineEnvironment,
      inlineFS,
      inlineConstants,
      reactRefresh,
      decorators,
      useDefineForClassFields,
    };
  },
  async transform({asset, config, options, logger}) {
    let [code, originalMap] = await Promise.all([
      asset.getBuffer(),
      asset.getMap(),
    ]);

    let targets;
    if (asset.env.isElectron() && asset.env.engines.electron) {
      targets = {
        electron: semver.minVersion(asset.env.engines.electron)?.toString(),
      };
    } else if (asset.env.isBrowser() && asset.env.engines.browsers) {
      targets = {};

      let browsers = Array.isArray(asset.env.engines.browsers)
        ? asset.env.engines.browsers
        : [asset.env.engines.browsers];

      // If the output format is esmodule, exclude browsers
      // that support them natively so that we transpile less.
      if (asset.env.outputFormat === 'esmodule') {
        browsers = [...browsers, ...ESMODULE_BROWSERS];
      }

      browsers = browserslist(browsers);
      for (let browser of browsers) {
        let [name, version] = browser.split(' ');
        if (BROWSER_MAPPING.hasOwnProperty(name)) {
          name = BROWSER_MAPPING[name];
          if (!name) {
            continue;
          }
        }

        let [major, minor = '0', patch = '0'] = version
          .split('-')[0]
          .split('.');
        if (isNaN(major) || isNaN(minor) || isNaN(patch)) {
          continue;
        }
        let semverVersion = `${major}.${minor}.${patch}`;

        if (targets[name] == null || semver.gt(targets[name], semverVersion)) {
          targets[name] = semverVersion;
        }
      }
    } else if (asset.env.isNode() && asset.env.engines.node) {
      targets = {node: semver.minVersion(asset.env.engines.node)?.toString()};
    }

    let env: EnvMap = {};

    if (!config?.inlineEnvironment) {
      if (options.env.NODE_ENV != null) {
        env.NODE_ENV = options.env.NODE_ENV;
      }

      if (process.env.PARCEL_BUILD_ENV === 'test') {
        env.PARCEL_BUILD_ENV = 'test';
      }
    } else if (Array.isArray(config?.inlineEnvironment)) {
      for (let match of globMatch(
        Object.keys(options.env),
        config.inlineEnvironment,
      )) {
        env[match] = String(options.env[match]);
      }
    } else {
      for (let key in options.env) {
        if (!key.startsWith('npm_')) {
          env[key] = String(options.env[key]);
        }
      }
    }

    let supportsModuleWorkers =
      asset.env.shouldScopeHoist && asset.env.supports('worker-module', true);
    let isJSX = Boolean(config?.isJSX);
    if (asset.type === 'ts') {
      isJSX = false;
    } else if (!isJSX) {
      isJSX = Boolean(JSX_EXTENSIONS[asset.type]);
    }

    let type = 'js';
    if (asset.type === 'ts' || asset.type === 'tsx' || asset.type === 'mdx') {
      type = asset.type;
    } else if (isJSX) {
      type = 'jsx';
    }

    let macroAssets = [];
    let {
      dependencies,
      code: compiledCode,
      map,
      shebang,
      hoist_result,
      symbol_result,
      needs_esm_helpers,
      diagnostics,
      used_env,
      has_node_replacements,
      is_constant_module,
      directives,
      helpers,
      mdx_exports,
      mdx_toc,
      mdx_assets,
    } = await (transformAsync || transform)({
      filename: asset.filePath,
      code,
      module_id: asset.id,
      project_root: options.projectRoot,
      inline_fs: Boolean(config?.inlineFS),
      context: asset.env.context,
      env,
      type,
      jsx_pragma: config?.pragma,
      jsx_pragma_frag: config?.pragmaFrag,
      automatic_jsx_runtime: Boolean(config?.automaticJSXRuntime),
      jsx_import_source: config?.jsxImportSource,
      is_development: options.mode === 'development',
      react_refresh: Boolean(config?.reactRefresh),
      decorators: Boolean(config?.decorators),
      use_define_for_class_fields: Boolean(config?.useDefineForClassFields),
      targets,
      source_maps: !!asset.env.sourceMap,
      scope_hoist:
        asset.env.shouldScopeHoist && asset.env.sourceType !== 'script',
      source_type: asset.env.sourceType === 'script' ? 'Script' : 'Module',
      supports_module_workers: supportsModuleWorkers,
      is_library: asset.env.isLibrary,
      is_esm_output: asset.env.outputFormat === 'esmodule',
      trace_bailouts: options.logLevel === 'verbose',
      is_swc_helpers: /@swc[/\\]helpers/.test(asset.filePath),
      standalone: asset.query.has('standalone'),
      inline_constants: config.inlineConstants,
      callMacro: asset.isSource
        ? async (err, src, exportName, args, loc) => {
            let mod;
            try {
              mod = await options.packageManager.require(src, asset.filePath);

              // Default interop for CommonJS modules.
              if (
                exportName === 'default' &&
                !mod.__esModule &&
                // $FlowFixMe
                Object.prototype.toString.call(config) !== '[object Module]'
              ) {
                mod = {default: mod};
              }

              if (!Object.hasOwnProperty.call(mod, exportName)) {
                throw new Error(`"${src}" does not export "${exportName}".`);
              }
            } catch (err) {
              throw {
                kind: 1,
                message: err.message,
              };
            }

            try {
              if (typeof mod[exportName] === 'function') {
                let ctx: MacroContext = {
                  // Allows macros to emit additional assets to add as dependencies (e.g. css).
                  addAsset(a: MacroAsset) {
                    let k = String(macroAssets.length);
                    let map;
                    if (asset.env.sourceMap) {
                      // Generate a source map that maps each line of the asset to the original macro call.
                      map = new SourceMap(options.projectRoot);
                      let mappings = [];
                      let line = 1;
                      for (let i = 0; i <= a.content.length; i++) {
                        if (i === a.content.length || a.content[i] === '\n') {
                          mappings.push({
                            generated: {
                              line,
                              column: 0,
                            },
                            source: asset.filePath,
                            original: {
                              line: loc.line,
                              column: loc.col,
                            },
                          });
                          line++;
                        }
                      }

                      map.addIndexedMappings(mappings);
                      if (originalMap) {
                        map.extends(originalMap);
                      } else {
                        map.setSourceContent(asset.filePath, code.toString());
                      }
                    }

                    macroAssets.push({
                      type: a.type,
                      content: a.content,
                      map,
                      uniqueKey: k,
                    });

                    asset.addDependency({
                      specifier: k,
                      specifierType: 'esm',
                    });
                  },
                  invalidateOnFileChange(filePath) {
                    asset.invalidateOnFileChange(filePath);
                  },
                  invalidateOnFileCreate(invalidation) {
                    asset.invalidateOnFileCreate(invalidation);
                  },
                  invalidateOnEnvChange(env) {
                    asset.invalidateOnEnvChange(env);
                  },
                  invalidateOnStartup() {
                    asset.invalidateOnStartup();
                  },
                  invalidateOnBuild() {
                    asset.invalidateOnBuild();
                  },
                };

                return mod[exportName].apply(ctx, args);
              } else {
                throw new Error(
                  `"${exportName}" in "${src}" is not a function.`,
                );
              }
            } catch (err) {
              // Remove parcel core from stack and build string so Rust can process errors more easily.
              let stack = (err.stack || '').split('\n').slice(1);
              let message = err.message;
              for (let line of stack) {
                if (line.includes(__filename)) {
                  break;
                }
                message += '\n' + line;
              }
              throw {
                kind: 2,
                message,
              };
            }
          }
        : null,
    });

    if (is_constant_module) {
      asset.meta.isConstantModule = true;
    }

    let convertLoc = (loc): SourceLocation => {
      let location = {
        filePath: asset.filePath,
        start: {
          line: loc.start_line + Number(asset.meta.startLine ?? 1) - 1,
          column: loc.start_col,
        },
        end: {
          line: loc.end_line + Number(asset.meta.startLine ?? 1) - 1,
          column: loc.end_col,
        },
      };

      // If there is an original source map, use it to remap to the original source location.
      if (originalMap) {
        location = remapSourceLocation(location, originalMap);
      }

      return location;
    };

    if (diagnostics) {
      let errors = diagnostics.filter(
        d =>
          d.severity === 'Error' ||
          (d.severity === 'SourceError' && asset.isSource),
      );
      let warnings = diagnostics.filter(
        d =>
          d.severity === 'Warning' ||
          (d.severity === 'SourceError' && !asset.isSource),
      );
      let convertDiagnostic = diagnostic => {
        let message = diagnostic.message;
        if (message === 'SCRIPT_ERROR') {
          let err = SCRIPT_ERRORS[(asset.env.context: string)];
          message = err?.message || SCRIPT_ERRORS.browser.message;
        }

        let res: Diagnostic = {
          message,
          codeFrames: [
            {
              filePath: asset.filePath,
              codeHighlights: diagnostic.code_highlights?.map(highlight =>
                convertSourceLocationToHighlight(
                  convertLoc(highlight.loc),
                  highlight.message ?? undefined,
                ),
              ),
            },
          ],
          hints: diagnostic.hints,
        };

        if (diagnostic.documentation_url) {
          res.documentationURL = diagnostic.documentation_url;
        }

        if (diagnostic.show_environment) {
          if (asset.env.loc && asset.env.loc.filePath !== asset.filePath) {
            res.codeFrames?.push({
              filePath: asset.env.loc.filePath,
              codeHighlights: [
                convertSourceLocationToHighlight(
                  asset.env.loc,
                  'The environment was originally created here',
                ),
              ],
            });
          }

          let err = SCRIPT_ERRORS[(asset.env.context: string)];
          if (err) {
            if (!res.hints) {
              res.hints = [err.hint];
            } else {
              res.hints.push(err.hint);
            }
          }
        }

        return res;
      };

      if (errors.length > 0) {
        throw new ThrowableDiagnostic({
          diagnostic: errors.map(convertDiagnostic),
        });
      }

      logger.warn(warnings.map(convertDiagnostic));
    }

    if (shebang) {
      asset.meta.interpreter = shebang;
    }

    if (has_node_replacements) {
      asset.meta.has_node_replacements = has_node_replacements;
    }

    if (asset.type === 'mdx') {
      asset.meta.ssgMeta = {
        exports: mdx_exports,
        tableOfContents: mdx_toc,
      };

      for (let [i, mdxAsset] of mdx_assets.entries()) {
        let map;
        if (asset.env.sourceMap && mdxAsset.position) {
          // Generate a source map that maps each line of the asset to the original code block.
          map = new SourceMap(options.projectRoot);
          let mappings = [];
          let line = 1;
          let column = mdxAsset.position.start.column;
          for (
            let i = mdxAsset.position.start.line + 1;
            i < mdxAsset.position.end.line;
            i++
          ) {
            mappings.push({
              generated: {
                line,
                column: 0,
              },
              source: asset.filePath,
              original: {
                line: i,
                column,
              },
            });
            line++;
            column = 0;
          }

          map.addIndexedMappings(mappings);
          if (originalMap) {
            map.extends(originalMap);
          } else {
            map.setSourceContent(asset.filePath, code.toString());
          }
        }

        macroAssets.push({
          type: mdxAsset.lang,
          content: mdxAsset.code,
          map,
          uniqueKey: 'mdx-' + i,
        });
      }
    }

    for (let env of used_env) {
      asset.invalidateOnEnvChange(env);
    }

    asset.meta.id = asset.id;
    asset.meta.directives = directives;
    asset.meta.usedHelpers = helpers;
    if (
      asset.env.isServer() &&
      !asset.env.isLibrary &&
      (directives.includes('use client') ||
        directives.includes('use client-entry'))
    ) {
      asset.setEnvironment({
        context: 'react-client',
        sourceType: 'module',
        outputFormat: 'esmodule',
        engines: asset.env.engines,
        includeNodeModules: true,
        isLibrary: false,
        sourceMap: asset.env.sourceMap,
        shouldOptimize: asset.env.shouldOptimize,
        shouldScopeHoist: asset.env.shouldScopeHoist,
      });
    } else if (
      !asset.env.isServer() &&
      !asset.env.isLibrary &&
      directives.includes('use server')
    ) {
      asset.setEnvironment({
        context: 'react-server',
        sourceType: 'module',
        outputFormat: 'commonjs',
        engines: asset.env.engines,
        includeNodeModules: false,
        isLibrary: false,
        sourceMap: asset.env.sourceMap,
        shouldOptimize: asset.env.shouldOptimize,
        shouldScopeHoist: asset.env.shouldScopeHoist,
      });
    } else if (directives.includes('use server-entry')) {
      if (!asset.env.isServer()) {
        throw new Error(
          'use server-entry must be imported in a server environment',
        );
      }
      asset.bundleBehavior = 'isolated';
    }

    // Server actions must always be wrapped so they can be parcelRequired.
    if (directives.includes('use server')) {
      asset.meta.shouldWrap = true;
    }

    for (let dep of dependencies) {
      if (dep.kind === 'WebWorker') {
        // Use native ES module output if the worker was created with `type: 'module'` and all targets
        // support native module workers. Only do this if parent asset output format is also esmodule so that
        // assets can be shared between workers and the main thread in the global output format.
        let outputFormat;
        if (
          asset.env.outputFormat === 'esmodule' &&
          dep.source_type === 'Module' &&
          supportsModuleWorkers
        ) {
          outputFormat = 'esmodule';
        } else {
          outputFormat =
            asset.env.outputFormat === 'commonjs' ? 'commonjs' : 'global';
        }

        let loc = convertLoc(dep.loc);
        asset.addURLDependency(dep.specifier, {
          loc,
          env: {
            context: 'web-worker',
            sourceType: dep.source_type === 'Module' ? 'module' : 'script',
            outputFormat,
            loc,
          },
          meta: {
            webworker: true,
            placeholder: dep.placeholder,
          },
        });
      } else if (dep.kind === 'ServiceWorker') {
        let loc = convertLoc(dep.loc);
        asset.addURLDependency(dep.specifier, {
          loc,
          needsStableName: true,
          env: {
            context: 'service-worker',
            sourceType: dep.source_type === 'Module' ? 'module' : 'script',
            outputFormat: 'global', // TODO: module service worker support
            loc,
          },
          meta: {
            placeholder: dep.placeholder,
          },
        });
      } else if (dep.kind === 'Worklet') {
        let loc = convertLoc(dep.loc);
        asset.addURLDependency(dep.specifier, {
          loc,
          env: {
            context: 'worklet',
            sourceType: 'module',
            outputFormat: 'esmodule', // Worklets require ESM
            loc,
          },
          meta: {
            placeholder: dep.placeholder,
          },
        });
      } else if (dep.kind === 'Url') {
        asset.addURLDependency(dep.specifier, {
          bundleBehavior: 'isolated',
          loc: convertLoc(dep.loc),
          needsStableName: Boolean(dep.flags & NEEDS_STABLE_NAME),
          meta: {
            placeholder: dep.placeholder,
          },
        });
      } else if (dep.kind === 'File') {
        asset.invalidateOnFileChange(dep.specifier);
      } else if (dep.kind === 'Id') {
        // Record parcelRequire calls so that the dev packager can add them as dependencies.
        // This allows the HMR runtime to collect parents across async boundaries (through runtimes).
        // TODO: ideally this would result as an actual dep in the graph rather than asset.meta.
        asset.meta.hmrDeps ??= [];
        invariant(Array.isArray(asset.meta.hmrDeps));
        asset.meta.hmrDeps.push(dep.specifier);
      } else {
        let meta: JSONObject = {kind: dep.kind};
        if (dep.attributes) {
          meta.importAttributes = dep.attributes;
        }

        if (dep.placeholder) {
          meta.placeholder = dep.placeholder;
        }

        if (dep.flags & REACT_LAZY) {
          meta.isReactLazy = true;
        }

        let env;
        if (dep.kind === 'DynamicImport') {
          // https://html.spec.whatwg.org/multipage/webappapis.html#hostimportmoduledynamically(referencingscriptormodule,-modulerequest,-promisecapability)
          if (asset.env.isWorklet() || asset.env.context === 'service-worker') {
            let loc = convertLoc(dep.loc);
            let diagnostic = {
              message: `import() is not allowed in ${
                asset.env.isWorklet() ? 'worklets' : 'service workers'
              }.`,
              codeFrames: [
                {
                  filePath: asset.filePath,
                  codeHighlights: [convertSourceLocationToHighlight(loc)],
                },
              ],
              hints: ['Try using a static `import`.'],
            };

            if (asset.env.loc) {
              diagnostic.codeFrames.push({
                filePath: asset.env.loc.filePath,
                codeHighlights: [
                  convertSourceLocationToHighlight(
                    asset.env.loc,
                    'The environment was originally created here',
                  ),
                ],
              });
            }

            throw new ThrowableDiagnostic({
              diagnostic,
            });
          }

          // If all of the target engines support dynamic import natively,
          // we can output native ESM if scope hoisting is enabled.
          // Only do this for scripts, rather than modules in the global
          // output format so that assets can be shared between the bundles.
          let outputFormat = asset.env.outputFormat;
          if (
            asset.env.sourceType === 'script' &&
            asset.env.shouldScopeHoist &&
            asset.env.supports('dynamic-import', true)
          ) {
            outputFormat = 'esmodule';
          }

          env = {
            sourceType: 'module',
            outputFormat,
            loc: convertLoc(dep.loc),
          };
        }

        // Always bundle helpers, even with includeNodeModules: false, except if this is a library.
        let isHelper =
          dep.flags & HELPER &&
          !(
            dep.specifier.endsWith('/jsx-runtime') ||
            dep.specifier.endsWith('/jsx-dev-runtime')
          );
        if (isHelper && !asset.env.isLibrary) {
          env = {
            ...env,
            includeNodeModules: true,
          };
        }

        // Add required version range for helpers.
        let range;
        if (isHelper) {
          let idx = dep.specifier.indexOf('/');
          if (dep.specifier[0] === '@') {
            idx = dep.specifier.indexOf('/', idx + 1);
          }
          let module = idx >= 0 ? dep.specifier.slice(0, idx) : dep.specifier;
          range = pkg.dependencies[module];
        }

        if (dep.attributes?.env === 'react-server') {
          env = {
            ...env,
            context: 'react-server',
            outputFormat: 'commonjs',
          };
        } else if (dep.attributes?.env === 'react-client') {
          env = {
            ...env,
            context: 'react-client',
            outputFormat: 'esmodule',
            includeNodeModules: true,
          };

          // This is a hack to prevent creating unnecessary shared bundles between actual client code
          // and server code that runs in the client environment (e.g. react).
          asset.isBundleSplittable = false;
        }

        asset.addDependency({
          specifier: dep.specifier,
          specifierType: dep.kind === 'Require' ? 'commonjs' : 'esm',
          loc: convertLoc(dep.loc),
          priority: dep.kind === 'DynamicImport' ? 'lazy' : 'sync',
          isOptional: Boolean(dep.flags & OPTIONAL),
          meta,
          resolveFrom: isHelper ? __filename : undefined,
          range,
          env,
        });
      }
    }

    if (hoist_result) {
      asset.symbols.ensure();
      for (let {
        exported,
        local,
        loc,
        is_esm,
      } of hoist_result.exported_symbols) {
        asset.symbols.set(exported, local, convertLoc(loc), {isEsm: is_esm});
      }

      // deps is a map of dependencies that are keyed by placeholder or specifier
      // If a placeholder is present, that is used first since placeholders are
      // hashed with DependencyKind's.
      // If not, the specifier is used along with its specifierType appended to
      // it to separate dependencies with the same specifier.
      let deps = new Map(
        asset
          .getDependencies()
          .map(dep => [dep.meta.placeholder ?? dep.specifier, dep]),
      );
      for (let dep of deps.values()) {
        dep.symbols.ensure();
      }

      for (let {
        source,
        local,
        imported,
        loc,
      } of hoist_result.imported_symbols) {
        let dep = deps.get(source);
        if (!dep) continue;
        dep.symbols.set(imported, local, convertLoc(loc));
      }

      for (let {source, local, imported, loc} of hoist_result.re_exports) {
        let dep = deps.get(source);
        if (!dep) continue;
        if (local === '*' && imported === '*') {
          dep.symbols.set('*', '*', convertLoc(loc), true);
        } else {
          let reExportName =
            dep.symbols.get(imported)?.local ??
            `$${asset.id}$re_export$${local}`;
          asset.symbols.set(local, reExportName);
          dep.symbols.set(imported, reExportName, convertLoc(loc), true);
        }
      }

      for (let specifier of hoist_result.wrapped_requires) {
        let dep = deps.get(specifier);
        if (!dep) continue;
        dep.meta.shouldWrap = true;
      }

      for (let name in hoist_result.dynamic_imports) {
        let dep = deps.get(hoist_result.dynamic_imports[name]);
        if (!dep) continue;
        dep.meta.promiseSymbol = name;
      }

      if (hoist_result.self_references.length > 0) {
        let symbols = new Map();
        for (let name of hoist_result.self_references) {
          // Do not create a self-reference for the `default` symbol unless we have seen an __esModule flag.
          if (
            name === 'default' &&
            !asset.symbols.hasExportSymbol('__esModule')
          ) {
            continue;
          }

          let local = nullthrows(asset.symbols.get(name)).local;
          symbols.set(name, {
            local,
            isWeak: false,
            loc: null,
          });
        }

        // Use the asset id as a unique key if one has not already been set.
        // This lets us create a dependency on the asset itself by using it as a specifier.
        // Using the unique key ensures that the dependency always resolves to the correct asset,
        // even if it came from a transformer that produced multiple assets (e.g. css modules).
        // Also avoids needing a resolution request.
        asset.uniqueKey ||= asset.id;
        asset.addDependency({
          specifier: asset.uniqueKey,
          specifierType: 'esm',
          symbols,
        });
      }

      // Add * symbol if there are CJS exports, no imports/exports at all
      // (and the asset has side effects), or the asset is wrapped.
      // This allows accessing symbols that don't exist without errors in symbol propagation.
      if (
        hoist_result.has_cjs_exports ||
        (!hoist_result.is_esm &&
          asset.sideEffects &&
          deps.size === 0 &&
          Object.keys(hoist_result.exported_symbols).length === 0) ||
        (hoist_result.should_wrap && !asset.symbols.hasExportSymbol('*'))
      ) {
        asset.symbols.set('*', `$${asset.id}$exports`);
      }

      asset.meta.hasCJSExports = hoist_result.has_cjs_exports;
      asset.meta.staticExports = hoist_result.static_cjs_exports;
      asset.meta.shouldWrap ||= hoist_result.should_wrap;
    } else {
      if (symbol_result) {
        let deps = new Map(
          asset
            .getDependencies()
            .map(dep => [dep.meta.placeholder ?? dep.specifier, dep]),
        );
        asset.symbols.ensure();

        for (let {exported, local, loc, source} of symbol_result.exports) {
          let dep = source ? deps.get(source) : undefined;
          asset.symbols.set(
            exported,
            `${dep?.id ?? ''}$${local}`,
            convertLoc(loc),
          );
          if (dep != null) {
            dep.symbols.ensure();
            dep.symbols.set(
              local,
              `${dep?.id ?? ''}$${local}`,
              convertLoc(loc),
              true,
            );
          }
        }

        for (let {source, local, imported, loc} of symbol_result.imports) {
          let dep = deps.get(source);
          if (!dep) continue;
          dep.symbols.ensure();
          dep.symbols.set(imported, local, convertLoc(loc));
        }

        for (let {source, loc} of symbol_result.exports_all) {
          let dep = deps.get(source);
          if (!dep) continue;
          dep.symbols.ensure();
          dep.symbols.set('*', '*', convertLoc(loc), true);
        }

        // Add * symbol if there are CJS exports, no imports/exports at all, or the asset is wrapped.
        // This allows accessing symbols that don't exist without errors in symbol propagation.
        if (
          symbol_result.has_cjs_exports ||
          (!symbol_result.is_esm &&
            deps.size === 0 &&
            symbol_result.exports.length === 0) ||
          (symbol_result.should_wrap && !asset.symbols.hasExportSymbol('*'))
        ) {
          asset.symbols.ensure();
          asset.symbols.set('*', `$${asset.id}$exports`);
        }
      } else {
        // If the asset is wrapped, add * as a fallback
        asset.symbols.ensure();
        asset.symbols.set('*', `$${asset.id}$exports`);
      }

      // For all other imports and requires, mark everything as imported (this covers both dynamic
      // imports and non-top-level requires.)
      for (let dep of asset.getDependencies()) {
        if (dep.symbols.isCleared) {
          dep.symbols.ensure();
          dep.symbols.set('*', `${dep.id}$`);
        }
      }

      if (needs_esm_helpers) {
        asset.addDependency({
          specifier: '@parcel/transformer-js/src/esmodule-helpers.js',
          specifierType: 'esm',
          resolveFrom: __filename,
          env: {
            includeNodeModules: {
              '@parcel/transformer-js': true,
            },
          },
        });
      }
    }

    asset.type = 'js';
    asset.setBuffer(compiledCode);

    if (map) {
      let sourceMap = new SourceMap(options.projectRoot);
      sourceMap.addVLQMap(JSON.parse(map));
      if (originalMap) {
        sourceMap.extends(originalMap);
      }
      asset.setMap(sourceMap);
    }

    return [asset, ...macroAssets];
  },
}): Transformer);
