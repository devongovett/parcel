// @flow
import {Resolver} from '@parcel/plugin';
import {
  isGlob,
  glob,
  globToRegex,
  relativePath,
  normalizeSeparators,
} from '@parcel/utils';
import path from 'path';
import nullthrows from 'nullthrows';
import ThrowableDiagnostic, {
  convertSourceLocationToHighlight,
} from '@parcel/diagnostic';
import NodeResolver from '@parcel/node-resolver-core';
import invariant from 'assert';

function errorToThrowableDiagnostic(error, dependency): ThrowableDiagnostic {
  return new ThrowableDiagnostic({
    diagnostic: {
      message: error,
      codeFrames: dependency.loc
        ? [
            {
              codeHighlights: [
                convertSourceLocationToHighlight(dependency.loc),
              ],
            },
          ]
        : undefined,
    },
  });
}

export default (new Resolver({
  async resolve({dependency, options, specifier, pipeline, logger}) {
    if (!isGlob(specifier)) {
      return;
    }

    let sourceAssetType = nullthrows(dependency.sourceAssetType);
    let sourceFile = nullthrows(
      dependency.resolveFrom ?? dependency.sourcePath,
    );

    let error;
    if (sourceAssetType !== 'js' && sourceAssetType !== 'css') {
      error = `Glob imports are not supported in ${sourceAssetType} files.`;
    } else if (
      dependency.specifierType === 'url' &&
      !dependency.meta?.isCSSImport
    ) {
      error = 'Glob imports are not supported in URL dependencies.';
    }

    if (error) {
      throw errorToThrowableDiagnostic(error, dependency);
    }

    let invalidateOnFileCreate = [];
    let invalidateOnFileChange = new Set();

    switch (specifier[0]) {
      // Path specifier
      case '.': {
        specifier = path.resolve(path.dirname(sourceFile), specifier);
        break;
      }

      // Absolute path. Make the glob relative to the project root.
      case '/': {
        specifier = path.resolve(options.projectRoot, specifier.slice(1));
        break;
      }

      // Tilde path. Package relative. Resolve relative to nearest node_modules
      // directory, the nearest directory with package.json or the project
      // root - whichever comes first.
      case '~': {
        let dir = path.dirname(sourceFile);
        let pkgPath = nullthrows(
          options.inputFS.findAncestorFile(
            ['package.json'],
            dir,
            options.projectRoot,
          ),
        );
        specifier = path.resolve(path.dirname(pkgPath), specifier.slice(2));
        break;
      }

      // Support package-ish specifiers like:
      //   foo      (node_module)
      //   @foo/bar (scoped node_module)
      //
      // First we resolve the initial portion using NodeResolver, then we tack
      // on the remaining glob.
      default: {
        // Globs are not paths - so they always use / (see https://github.com/micromatch/micromatch#backslashes)
        let splitOn = specifier.indexOf('/');
        if (specifier[0] === '@') {
          splitOn = specifier.indexOf('/', splitOn + 1);
        }

        // Since we've already asserted earlier that there is a glob present, it shouldn't be
        // possible for there to be only a package here without any other path parts (e.g. `import('pkg')`)
        invariant(splitOn !== -1);

        let pkg = specifier.substring(0, splitOn);
        let rest = specifier.substring(splitOn + 1);

        // This initialisation code is copied from the DefaultResolver
        const resolver = new NodeResolver({
          fs: options.inputFS,
          projectRoot: options.projectRoot,
          packageManager: options.shouldAutoInstall
            ? options.packageManager
            : undefined,
          mode: options.mode,
          logger,
        });

        let result;
        try {
          result = await resolver.resolve({
            filename: pkg + '/package.json',
            parent: dependency.resolveFrom,
            specifierType: 'esm',
            env: dependency.env,
            sourcePath: dependency.sourcePath,
          });
        } catch (err) {
          if (err instanceof ThrowableDiagnostic) {
            // Return instead of throwing so we can provide invalidations.
            return {
              diagnostics: err.diagnostics,
              invalidateOnFileCreate,
              invalidateOnFileChange: [...invalidateOnFileChange],
            };
          } else {
            throw err;
          }
        }

        if (!result || !result.filePath) {
          throw errorToThrowableDiagnostic(
            `Unable to resolve ${pkg} from ${sourceFile} when resolving specifier ${specifier}`,
            dependency,
          );
        }

        specifier = path.resolve(path.dirname(result.filePath), rest);
        if (result.invalidateOnFileChange) {
          for (let f of result.invalidateOnFileChange) {
            invalidateOnFileChange.add(f);
          }
        }
        if (result.invalidateOnFileCreate) {
          invalidateOnFileCreate.push(...result.invalidateOnFileCreate);
        }
      }
    }

    let normalized = normalizeSeparators(specifier);
    let files = await glob(normalized, options.inputFS, {
      onlyFiles: true,
    });

    let dir = path.dirname(sourceFile);
    let results = files.map(file => {
      let relative = relativePath(dir, file);
      if (pipeline) {
        relative = `${pipeline}:${relative}`;
      }

      return [file, relative];
    });

    let code = '';
    if (sourceAssetType === 'js') {
      let re = globToRegex(normalized, {capture: true});
      let matches = {};
      for (let [file, relative] of results) {
        let match = file.match(re);
        if (!match) continue;
        let parts = match
          .slice(1)
          .filter(Boolean)
          .reduce((a, p) => a.concat(p.split('/')), []);
        set(matches, parts, relative);
      }

      let {value, imports} = generate(
        matches,
        dependency.priority === 'lazy',
        '',
        0,
        dependency.specifierType,
      );
      if (dependency.specifierType === 'esm') {
        code = imports + 'export ' + value;
      } else {
        code = imports + 'module.exports = ' + value;
      }
    } else if (sourceAssetType === 'css') {
      for (let [, relative] of results) {
        code += `@import "${relative}";\n`;
      }
    }

    invalidateOnFileCreate.push({glob: normalized});

    return {
      filePath: path.join(
        dir,
        path.basename(specifier, path.extname(specifier)) +
          '.' +
          sourceAssetType,
      ),
      code,
      invalidateOnFileCreate,
      invalidateOnFileChange: [...invalidateOnFileChange],
      pipeline: null,
      priority: 'sync',
    };
  },
}): Resolver);

function set(obj, path, value) {
  for (let i = 0; i < path.length - 1; i++) {
    let part = path[i];

    if (obj[part] == null) {
      obj[part] = {};
    }

    obj = obj[part];
  }

  obj[path[path.length - 1]] = value;
}

function generate(
  matches,
  isAsync,
  indent = '',
  count = 0,
  specifierType = 'commonjs',
) {
  if (typeof matches === 'string') {
    let key = `_temp${count++}`;
    let imports;
    if (isAsync) {
      imports = `const ${key} = () => import(${JSON.stringify(matches)});`;
    } else {
      if (specifierType === 'esm') {
        imports = `import * as ${key} from ${JSON.stringify(matches)};`;
      } else {
        imports = `const ${key} = require(${JSON.stringify(matches)});`;
      }
    }
    return {
      imports,
      value: key,
      count,
    };
  }

  let imports = '';
  let res = indent + '{';

  let first = true;
  for (let key in matches) {
    if (!first) {
      res += ',';
    }

    let {
      imports: i,
      value,
      count: c,
    } = generate(matches[key], isAsync, indent + '  ', count, specifierType);
    imports += `${i}\n`;
    count = c;

    if (specifierType === 'esm') {
      res += `\n${indent} ${value} as ${JSON.stringify(key)}`;
    } else {
      res += `\n${indent} ${JSON.stringify(key)}: ${value}`;
    }

    first = false;
  }
  res += '\n' + indent + '}';
  return {imports, value: res, count};
}
