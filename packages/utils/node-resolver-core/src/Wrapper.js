// @flow
import type {FilePath, SpecifierType, SemverRange, Environment, SourceLocation, BuildMode, ResolveResult, PluginLogger} from '@parcel/types';
import type {FileSystem} from '@parcel/fs';
import type {PackageManager} from '@parcel/package-manager';
import type {Diagnostic} from '@parcel/diagnostic';
import {Resolver} from '../index';
import builtins, {empty} from './builtins';
import path from 'path';
import {
  relativePath,
  findAlternativeNodeModules,
  findAlternativeFiles,
  loadConfig,
  getModuleParts,
} from '@parcel/utils';
import ThrowableDiagnostic, {
  encodeJSONKeyComponent,
  errorToDiagnostic,
  generateJSONCodeHighlights,
  md,
} from '@parcel/diagnostic';
import semver from 'semver';
import {parse} from '@mischnic/json-sourcemap';

type Options = {|
  fs: FileSystem,
  projectRoot: FilePath,
  extensions: Array<string>,
  mainFields: Array<string>,
  packageManager?: PackageManager,
  logger?: PluginLogger,
  shouldAutoInstall?: boolean,
  mode?: BuildMode,
|};

// Exports conditions.
// These must match the values in package_json.rs.
const NODE = 1 << 3;
const BROWSER = 1 << 4;
const WORKER = 1 << 5;
const WORKLET = 1 << 6;
const ELECTRON = 1 << 7;
const DEVELOPMENT = 1 << 8;
const PRODUCTION = 1 << 9;

type ResolveOptions = {|
  filename: FilePath,
  parent: ?FilePath,
  specifierType: SpecifierType,
  range?: ?SemverRange,
  env: Environment,
  sourcePath?: ?FilePath,
  loc?: ?SourceLocation,
|};

export default class NodeResolver {
  resolversByEnv: Map<string, any>;
  projectRoot: FilePath;
  options: Options;

  constructor(options: Options) {
    this.options = options;
    this.resolversByEnv = new Map();
  }

  async resolve(options: ResolveOptions): Promise<?ResolveResult> {
    let resolver = this.resolversByEnv.get(options.env.id);
    if (!resolver) {
      resolver = new Resolver(this.options.projectRoot, {
        fs: {
          canonicalize: path => this.options.fs.realpathSync(path),
          read: path => this.options.fs.readFileSync(path),
          isFile: path => this.options.fs.statSync(path).isFile(),
          isDir: path => this.options.fs.statSync(path).isDirectory()
        },
        includeNodeModules: options.env.includeNodeModules,
        isBrowser: options.env.isBrowser(),
        conditions: environmentToExportsConditions(options.env, this.options.mode)
      });
      this.resolversByEnv.set(options.env.id, resolver);
    }

    // Special case for entries. Convert absolute paths to relative from project root.
    if (options.parent == null) {
      options.parent = path.join(this.options.projectRoot, 'index');
      if (path.isAbsolute(options.filename)) {
        options.filename = relativePath(this.options.projectRoot, options.filename);
      }
    }

    let res = resolver.resolve(options);

    if (res.error) {
      let diagnostic = await this.handleError(res.error, options);
      return {
        diagnostics: diagnostic ? [diagnostic] : [],
        invalidateOnFileCreate: res.invalidateOnFileCreate,
        invalidateOnFileChange: res.invalidateOnFileChange
      };
    }

    switch (res.resolution?.type) {
      case 'Path':
        return {
          filePath: res.resolution.value,
          invalidateOnFileCreate: res.invalidateOnFileCreate,
          invalidateOnFileChange: res.invalidateOnFileChange,
          sideEffects: res.sideEffects,
          query: res.query != null ? new URLSearchParams(res.query) : undefined
        };
      case 'Builtin':
        return this.resolveBuiltin(res.resolution.value, options);
      case 'External': {
        if (options.sourcePath && options.env.isLibrary && options.specifierType !== 'url') {
          let diagnostic = await this.checkExcludedDependency(options.sourcePath, options.filename, options);
          if (diagnostic) {
            return {
              diagnostics: [diagnostic],
              invalidateOnFileCreate: res.invalidateOnFileCreate,
              invalidateOnFileChange: res.invalidateOnFileChange
            };
          }
        }
  
        // TODO: invalidations?
        return {isExcluded: true};
      }
      case 'Empty':
        return {filePath: empty};
      case 'Global':
        return {
          filePath: path.join(this.projectRoot, `${res.resolution.value}.js`),
          code: `module.exports=${res.resolution.value};`,
        };
      default:
        return null;
    }
  }

  async resolveBuiltin(name: string, options: ResolveOptions): Promise<?ResolveResult> {
    if (options.env.isNode()) {
      return {isExcluded: true};
    }

    if (options.env.isElectron() && name === 'electron') {
      return {isExcluded: true};
    }

    // By default, exclude node builtins from libraries unless explicitly opted in.
    if (
      options.env.isLibrary &&
      this.shouldIncludeNodeModule(options.env, name) !== true
    ) {
      return {isExcluded: true};
    }

    let builtin = builtins[name];
    if (!builtin || builtin.name === empty) {
      return {
        filePath: empty
      };
    }

    let resolved = await this.resolve({
      ...options,
      filename: builtin.name,
    });

    // Autoinstall/verify version of builtin polyfills
    if (builtin.range != null) {
      // This assumes that there are no polyfill packages that are scoped
      // Append '/' to force this.packageManager to look up the package in node_modules
      let packageName = builtin.name.split('/')[0] + '/';
      let packageManager = this.options.packageManager;
      if (resolved?.filePath == null) {
        // Auto install the Node builtin polyfills
        if (this.options.shouldAutoInstall && packageManager) {
          this.options.logger?.warn({
            message: md`Auto installing polyfill for Node builtin module "${packageName}"...`,
            codeFrames: options.loc ? [
              {
                filePath: options.loc.filePath,
                codeHighlights: options.loc
                  ? [
                      {
                        message: 'used here',
                        start: options.loc.start,
                        end: options.loc.end,
                      },
                    ]
                  : [],
              },
            ] : [],
            documentationURL:
              'https://parceljs.org/features/node-emulation/#polyfilling-%26-excluding-builtin-node-modules',
          });

          await packageManager.resolve(
            packageName,
            this.projectRoot + '/index',
            {
              saveDev: true,
              shouldAutoInstall: true,
              range: builtin.range,
            },
          );

          // Re-resolve
          return this.resolve({
            ...options,
            filename: builtin.name,
            parent: this.options.projectRoot + '/index',
          });
        } else {
          throw new ThrowableDiagnostic({
            diagnostic: {
              message: md`Node builtin polyfill "${packageName}" is not installed, but auto install is disabled.`,
              codeFrames: options.loc ? [
                {
                  filePath: options.loc.filePath,
                  codeHighlights: [
                    {
                      message: 'used here',
                      start: options.loc.start,
                      end: options.loc.end,
                    },
                  ]
                },
              ] : [],
              documentationURL:
                'https://parceljs.org/features/node-emulation/#polyfilling-%26-excluding-builtin-node-modules',
              hints: [
                md`Install the "${packageName}" package with your package manager, and run Parcel again.`,
              ],
            },
          });
        }
      } else if (builtin.range != null) {
        // Assert correct version
        try {
          // TODO packageManager can be null for backwards compatibility, but that could cause invalid
          // resolutions in monorepos
          await packageManager?.resolve(
            packageName,
            this.options.projectRoot + '/index',
            {
              saveDev: true,
              shouldAutoInstall: this.options.shouldAutoInstall,
              range: builtin.range,
            },
          );
        } catch (e) {
          this.options.logger?.warn(errorToDiagnostic(e));
        }
      }
    }

    return resolved;
  }

  shouldIncludeNodeModule(
    {includeNodeModules}: Environment,
    name: string,
  ): ?boolean {
    if (includeNodeModules === false) {
      return false;
    }

    if (Array.isArray(includeNodeModules)) {
      let [moduleName] = getModuleParts(name);
      return includeNodeModules.includes(moduleName);
    }

    if (includeNodeModules && typeof includeNodeModules === 'object') {
      let [moduleName] = getModuleParts(name);
      let include = includeNodeModules[moduleName];
      if (include != null) {
        return !!include;
      }
    }
  }

  async handleError(error: any, options: ResolveOptions): Promise<?Diagnostic> {
    // console.log(error)
    switch (error.type) {
      case 'FileNotFound': {
        let dir = path.dirname(error.from);
        let relative = error.relative;
        if (!relative.startsWith('.')) {
          relative = './' + relative;
        }

        let potentialFiles = await findAlternativeFiles(
          this.options.fs,
          relative,
          dir,
          this.options.projectRoot,
          true,
          options.specifierType !== 'url',
          // extensions.length === 0,
        );

        return {
          message: md`Cannot load file '${relative}' in '${relativePath(
            this.options.projectRoot,
            dir,
          )}'.`,
          hints: potentialFiles.map(r => {
            return `Did you mean '__${r}__'?`;
          }),
        };
      }
      case 'ModuleNotFound': {
        let alternativeModules = await findAlternativeNodeModules(
          this.options.fs,
          error.module,
          options.parent ? path.dirname(options.parent) : this.options.projectRoot,
        );
  
        return {
          message: md`Cannot find module '${error.module}'`,
          hints: alternativeModules.map(r => {
            return `Did you mean '__${r}__'?`;
          }),
        };
      }
      case 'ModuleEntryNotFound': {
        let dir = path.dirname(error.package_path);
        let fileSpecifier = relativePath(dir, error.entry_path);
        let alternatives = await findAlternativeFiles(
          this.options.fs,
          fileSpecifier,
          dir,
          this.options.projectRoot,
        );

        let alternative = alternatives[0];
        let pkgContent = await this.options.fs.readFile(error.package_path, 'utf8');
        return {
          message: md`Could not load '${fileSpecifier}' from module '${error.module}' found in package.json#${error.field}`,
          codeFrames: [
            {
              filePath: error.package_path,
              language: 'json',
              code: pkgContent,
              codeHighlights: generateJSONCodeHighlights(pkgContent, [
                {
                  key: `/${error.field}`,
                  type: 'value',
                  message: md`'${fileSpecifier}' does not exist${
                    alternative ? `, did you mean '${alternative}'?` : ''
                  }'`,
                },
              ]),
            },
          ],
        };
      }
      case 'ModuleSubpathNotFound': {
        let dir = path.dirname(error.package_path);
        let relative = relativePath(dir, error.path, false);
        let pkgContent = await this.options.fs.readFile(error.package_path, 'utf8');
        let pkg = JSON.parse(pkgContent);
        let potentialFiles = [];
        if (!pkg.exports) {
          potentialFiles = await findAlternativeFiles(
            this.options.fs,
            relative,
            dir,
            this.options.projectRoot,
            false
          );

          if (!relative.startsWith('.')) {
            relative = './' + relative;
          }
        }

        return {
          message: md`Cannot load file '${relative}' from module '${error.module}'`,
          hints: potentialFiles.map(r => {
            return `Did you mean '__${error.module}/${r}__'?`;
          }),
        };
      }
      case 'JsonError': {
        let pkgContent = await this.options.fs.readFile(error.path, 'utf8');
        return {
          message: md`Error parsing JSON`,
          codeFrames: [
            {
              filePath: error.path,
              language: 'json',
              code: pkgContent,
              codeHighlights: [
                {
                  message: error.message,
                  start: {
                    line: error.line,
                    column: error.column
                  },
                  end: {
                    line: error.line,
                    column: error.column
                  }
                }
              ]
            },
          ],
        };
      }
      case 'EmptySpecifier': {
        return {
          message: md`Invalid empty specifier`,
          codeFrames: options.loc ? [
            {
              filePath: options.loc.filePath,
              codeHighlights: [
                {
                  start: options.loc.start,
                  end: options.loc.end
                }
              ]
            }
          ] : []
        };
      }
      case 'UnknownScheme': {
        return {
          message: md`Unknown url scheme or pipeline '${error.scheme}:'`,
          // codeFrames: options.loc ? [
          //   {
          //     filePath: options.loc.filePath,
          //     codeHighlights: [
          //       {
          //         start: options.loc.start,
          //         end: options.loc.end
          //       }
          //     ]
          //   }
          // ] : []
        };
      }
      case 'PackageJsonError': {
        let pkgContent = await this.options.fs.readFile(error.path, 'utf8');
        // TODO: find alternative exports?
        switch (error.error) {
          case 'PackagePathNotExported': {
            return {
              message: md`Module '${options.filename}' is not exported from the '${error.module}' package`,
              codeFrames: [
                {
                  filePath: error.path,
                  language: 'json',
                  code: pkgContent,
                  codeHighlights: generateJSONCodeHighlights(pkgContent, [
                    {
                      key: `/exports`,
                      type: 'value',
                    },
                  ]),
                },
              ],
            };
          }
          case 'ImportNotDefined': {
            let parsed = parse(pkgContent);
            return {
              message: md`Package import '${options.filename}' is not defined in the '${error.module}' package`,
              codeFrames: [
                {
                  filePath: error.path,
                  language: 'json',
                  code: pkgContent,
                  codeHighlights: parsed.pointers['/imports'] ? generateJSONCodeHighlights(parsed, [
                    {
                      key: `/imports`,
                      type: 'value',
                    },
                  ]) : [],
                },
              ],
            };
          }
          // TODO: InvalidPackageTarget, InvalidSpecifier
        }
        break;
      }
      case 'PackageJsonNotFound': {
        return {
          message: md`Cannot find a package.json above '${relativePath(
            this.options.projectRoot,
            options.parent ? path.dirname(options.parent) : this.options.projectRoot,
          )}'`,
        };
      }
      // TODO: UnknownError, IOError, InvalidAlias
    }
  }

  async checkExcludedDependency(
    sourceFile: FilePath,
    name: string,
    options: ResolveOptions,
  ): Promise<?Diagnostic> {
    let [moduleName] = getModuleParts(name);
    let res = await loadConfig(
      this.options.fs,
      sourceFile,
      ['package.json'],
      this.projectRoot,
      // By default, loadConfig uses JSON5. Use normal JSON for package.json files
      // since they don't support comments and JSON.parse is faster.
      {parser: (...args) => JSON.parse(...args)},
    );
    if (!res) {
      return;
    }
    
    let pkg = res.config;
    let pkgfile = res.files[0].filePath;
    if (
      !pkg.dependencies?.[moduleName] &&
      !pkg.peerDependencies?.[moduleName] &&
      !pkg.engines?.[moduleName]
    ) {
      let pkgContent = await this.options.fs.readFile(pkgfile, 'utf8');
      return {
        message: md`External dependency "${moduleName}" is not declared in package.json.`,
        codeFrames: [
          {
            filePath: pkgfile,
            language: 'json',
            code: pkgContent,
            codeHighlights: pkg.dependencies
              ? generateJSONCodeHighlights(pkgContent, [
                  {
                    key: `/dependencies`,
                    type: 'key',
                  },
                ])
              : [
                  {
                    start: {
                      line: 1,
                      column: 1,
                    },
                    end: {
                      line: 1,
                      column: 1,
                    },
                  },
                ],
          },
        ],
        hints: [`Add "${moduleName}" as a dependency.`],
      };
    }

    if (options.range) {
      let range = options.range;
      let depRange =
        pkg.dependencies?.[moduleName] || pkg.peerDependencies?.[moduleName];
      if (depRange && !semver.intersects(depRange, range)) {
        let pkgContent = await this.options.fs.readFile(pkgfile, 'utf8');
        let field = pkg.dependencies?.[moduleName]
          ? 'dependencies'
          : 'peerDependencies';
        return {
          message: md`External dependency "${moduleName}" does not satisfy required semver range "${range}".`,
          codeFrames: [
            {
              filePath: pkgfile,
              language: 'json',
              code: pkgContent,
              codeHighlights: generateJSONCodeHighlights(pkgContent, [
                {
                  key: `/${field}/${encodeJSONKeyComponent(moduleName)}`,
                  type: 'value',
                  message: 'Found this conflicting requirement.',
                },
              ]),
            },
          ],
          hints: [
            `Update the dependency on "${moduleName}" to satisfy "${range}".`,
          ],
        };
      }
    }
  }
}

function environmentToExportsConditions(env: Environment, mode: ?BuildMode): number {
  let conditions = 0;
  if (env.isBrowser()) {
    conditions |= BROWSER;
  }

  if (env.isWorker()) {
    conditions |= WORKER;
  }

  if (env.isWorklet()) {
    conditions |= WORKLET;
  }

  if (env.isElectron()) {
    conditions |= ELECTRON;
  }

  if (env.isNode()) {
    conditions |= NODE;
  }

  if (mode === 'production') {
    conditions |= PRODUCTION;
  } else if (mode === 'development') {
    conditions |= DEVELOPMENT;
  }

  return conditions;
}
