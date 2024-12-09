// @flow strict-local

import type {SourceLocation} from '@parcel/types';

import path from 'path';
import SourceMap from '@parcel/source-map';
import {Transformer} from '@parcel/plugin';
import {
  remapSourceLocation,
  relativePath,
  globToRegex,
  normalizeSeparators,
} from '@parcel/utils';
import {type SourceLocation as LightningSourceLocation} from 'lightningcss';
import * as native from 'lightningcss';
import browserslist from 'browserslist';
import nullthrows from 'nullthrows';
import ThrowableDiagnostic, {errorToDiagnostic} from '@parcel/diagnostic';

const {transform, transformStyleAttribute, browserslistToTargets} = native;

export default (new Transformer({
  async loadConfig({config, options}) {
    let conf = await config.getConfigFrom(options.projectRoot + '/index', [], {
      packageKey: '@parcel/transformer-css',
    });
    let contents = conf?.contents;
    if (typeof contents?.cssModules?.include === 'string') {
      contents.cssModules.include = [globToRegex(contents.cssModules.include)];
    } else if (Array.isArray(contents?.cssModules?.include)) {
      contents.cssModules.include = contents.cssModules.include.map(include =>
        typeof include === 'string' ? globToRegex(include) : include,
      );
    }
    if (typeof contents?.cssModules?.exclude === 'string') {
      contents.cssModules.exclude = [globToRegex(contents.cssModules.exclude)];
    } else if (Array.isArray(contents?.cssModules?.exclude)) {
      contents.cssModules.exclude = contents.cssModules.exclude.map(exclude =>
        typeof exclude === 'string' ? globToRegex(exclude) : exclude,
      );
    }
    return contents;
  },
  async transform({asset, config, options, logger}) {
    // Normalize the asset's environment so that properties that only affect JS don't cause CSS to be duplicated.
    // For example, with ESModule and CommonJS targets, only a single shared CSS bundle should be produced.
    let env = {
      context: asset.env.context,
      outputFormat: asset.env.outputFormat,
      engines: asset.env.engines,
      includeNodeModules: asset.env.includeNodeModules,
      sourceType: asset.env.sourceType,
      isLibrary: asset.env.isLibrary,
      shouldOptimize: asset.env.shouldOptimize,
      shouldScopeHoist: asset.env.shouldScopeHoist,
      sourceMap: asset.env.sourceMap,
      loc: asset.env.loc,
    };

    asset.setEnvironment({
      context: 'browser',
      engines: {
        browsers: asset.env.engines.browsers,
      },
      shouldOptimize: asset.env.shouldOptimize,
      shouldScopeHoist: asset.env.shouldScopeHoist,
      sourceMap: asset.env.sourceMap,
    });

    let [code, originalMap] = await Promise.all([
      asset.getBuffer(),
      asset.getMap(),
      // $FlowFixMe native.default is the init function only when bundled for the browser build
      process.browser && native.default(),
    ]);

    let targets = getTargets(asset.env.engines.browsers);
    let res;
    try {
      if (asset.meta.type === 'attr') {
        res = transformStyleAttribute({
          code,
          analyzeDependencies: true,
          errorRecovery: config?.errorRecovery || false,
          targets,
        });
      } else {
        let cssModules = false;
        if (
          asset.meta.type !== 'tag' &&
          asset.meta.cssModulesCompiled == null
        ) {
          let cssModulesConfig = config?.cssModules;
          let isCSSModule = /\.module\./.test(asset.filePath);
          if (asset.isSource) {
            let projectRootPath = path.relative(
              options.projectRoot,
              asset.filePath,
            );
            if (typeof cssModulesConfig === 'boolean') {
              isCSSModule = true;
            } else if (cssModulesConfig?.include) {
              isCSSModule = cssModulesConfig.include.some(include =>
                include.test(projectRootPath),
              );
            } else if (cssModulesConfig?.global) {
              isCSSModule = true;
            }

            if (
              cssModulesConfig?.exclude?.some(exclude =>
                exclude.test(projectRootPath),
              )
            ) {
              isCSSModule = false;
            }
          }

          if (isCSSModule) {
            if (cssModulesConfig?.dashedIdents && !asset.isSource) {
              cssModulesConfig.dashedIdents = false;
            }

            cssModules = cssModulesConfig ?? true;
          }
        }

        res = transform({
          filename: normalizeSeparators(
            path.relative(options.projectRoot, asset.filePath),
          ),
          code,
          cssModules,
          analyzeDependencies:
            asset.meta.hasDependencies !== false
              ? {
                  preserveImports: true,
                }
              : false,
          sourceMap: !!asset.env.sourceMap,
          drafts: config?.drafts,
          pseudoClasses: config?.pseudoClasses,
          errorRecovery: config?.errorRecovery || false,
          targets,
        });
      }
    } catch (err) {
      err.filePath = asset.filePath;
      let diagnostic = errorToDiagnostic(err, {
        origin: '@parcel/transformer-css',
      });
      if (err.data?.type === 'AmbiguousUrlInCustomProperty' && err.data.url) {
        let p =
          '/' +
          relativePath(
            options.projectRoot,
            path.resolve(path.dirname(asset.filePath), err.data.url),
            false,
          );
        diagnostic[0].hints = [`Replace with: url(${p})`];
        diagnostic[0].documentationURL =
          'https://parceljs.org/languages/css/#url()';
      }

      throw new ThrowableDiagnostic({
        diagnostic,
      });
    }

    if (res.warnings) {
      for (let warning of res.warnings) {
        logger.warn({
          message: warning.message,
          codeFrames: [
            {
              filePath: asset.filePath,
              codeHighlights: [
                {
                  start: {
                    line: warning.loc.line,
                    column: warning.loc.column + 1,
                  },
                  end: {
                    line: warning.loc.line,
                    column: warning.loc.column + 1,
                  },
                },
              ],
            },
          ],
        });
      }
    }

    if (res.map != null) {
      let vlqMap = JSON.parse(Buffer.from(res.map).toString());
      let map = new SourceMap(options.projectRoot);
      map.addVLQMap(vlqMap);

      if (originalMap) {
        map.extends(originalMap);
      }

      asset.setMap(map);
    }

    if (res.dependencies) {
      for (let dep of res.dependencies) {
        let loc = convertLoc(dep.loc);
        if (originalMap) {
          loc = remapSourceLocation(loc, originalMap);
        }

        if (dep.type === 'import' && !res.exports) {
          asset.addDependency({
            specifier: dep.url,
            specifierType: 'url',
            loc,
            packageConditions: ['style'],
            meta: {
              // For the glob resolver to distinguish between `@import` and other URL dependencies.
              isCSSImport: true,
              media: dep.media,
              placeholder: dep.placeholder,
            },
          });
        } else if (dep.type === 'url') {
          asset.addURLDependency(dep.url, {
            loc,
            meta: {
              placeholder: dep.placeholder,
            },
          });
        }
      }
    }

    let assets = [asset];
    let buffer = Buffer.from(res.code);

    if (res.exports != null) {
      let exports = res.exports;
      asset.symbols.ensure();
      asset.symbols.set('default', 'default');

      let dependencies = new Map();
      let locals = new Map();
      let c = 0;
      let depjs = '';
      let js = '';
      let cssImports = '';

      let jsDeps = [];

      for (let key in exports) {
        locals.set(exports[key].name, key);
      }

      asset.uniqueKey ??= asset.id;

      let seen = new Set();
      let add = key => {
        if (seen.has(key)) {
          return;
        }
        seen.add(key);

        let e = exports[key];
        let s = `module.exports[${JSON.stringify(key)}] = \`${e.name}`;

        for (let ref of e.composes) {
          s += ' ';
          if (ref.type === 'local') {
            let exported = nullthrows(locals.get(ref.name));
            add(exported);
            s += '${' + `module.exports[${JSON.stringify(exported)}]` + '}';
            asset.addDependency({
              specifier: nullthrows(asset.uniqueKey),
              specifierType: 'esm',
              symbols: new Map([
                [exported, {local: ref.name, isWeak: false, loc: null}],
              ]),
              env,
            });
          } else if (ref.type === 'global') {
            s += ref.name;
          } else if (ref.type === 'dependency') {
            let d = dependencies.get(ref.specifier);
            if (d == null) {
              d = `dep_${c++}`;
              depjs += `import * as ${d} from ${JSON.stringify(
                ref.specifier,
              )};\n`;
              dependencies.set(ref.specifier, d);
              cssImports += `@import "${ref.specifier}";\n`;
              asset.addDependency({
                specifier: ref.specifier,
                specifierType: 'esm',
                packageConditions: ['style'],
                env,
              });
            }
            s += '${' + `${d}[${JSON.stringify(ref.name)}]` + '}';
          }
        }

        s += '`;\n';

        // If the export is referenced internally (e.g. used @keyframes), add a self-reference
        // to the JS so the symbol is retained during tree-shaking.
        if (e.isReferenced) {
          s += `module.exports[${JSON.stringify(key)}];\n`;
          asset.addDependency({
            specifier: nullthrows(asset.uniqueKey),
            specifierType: 'esm',
            symbols: new Map([
              [key, {local: exports[key].name, isWeak: false, loc: null}],
            ]),
            env,
          });
        }

        js += s;
      };

      // It's possible that the exports can be ordered differently between builds.
      // Sorting by key is safe as the order is irrelevant but needs to be deterministic.
      for (let key of Object.keys(exports).sort()) {
        asset.symbols.set(key, exports[key].name);
        add(key);
      }

      if (res.dependencies) {
        for (let dep of res.dependencies) {
          if (dep.type === 'import') {
            // TODO: Figure out how to treeshake this
            let d = `dep_$${c++}`;
            depjs += `import * as ${d} from ${JSON.stringify(dep.url)};\n`;
            js += `for (let key in ${d}) { if (key in module.exports) module.exports[key] += ' ' + ${d}[key]; else module.exports[key] = ${d}[key]; }\n`;
            asset.symbols.set('*', '*');
          }
        }
      }

      if (res.references != null) {
        let references = res.references;
        for (let symbol in references) {
          let reference = references[symbol];
          asset.addDependency({
            specifier: reference.specifier,
            specifierType: 'esm',
            packageConditions: ['style'],
            symbols: new Map([
              [reference.name, {local: symbol, isWeak: false, loc: null}],
            ]),
            env,
          });

          asset.meta.hasReferences = true;
          cssImports += `@import "${reference.specifier}";\n`;
        }
      }

      assets.push({
        type: 'js',
        content: depjs + js,
        dependencies: jsDeps,
        env,
      });

      // Prepend @import rules for each composes dependency so packager knows where to insert them.
      if (cssImports.length > 0) {
        buffer = Buffer.concat([Buffer.from(cssImports), buffer]);
      }
    }

    asset.setBuffer(buffer);
    return assets;
  },
}): Transformer);

let cache = new Map();

function getTargets(browsers) {
  if (browsers == null) {
    return undefined;
  }

  let cached = cache.get(browsers);
  if (cached != null) {
    return cached;
  }

  let targets = browserslistToTargets(browserslist(browsers));

  cache.set(browsers, targets);
  return targets;
}

function convertLoc(loc: LightningSourceLocation): SourceLocation {
  return {
    filePath: loc.filePath,
    start: {line: loc.start.line, column: loc.start.column},
    end: {line: loc.end.line, column: loc.end.column + 1},
  };
}
