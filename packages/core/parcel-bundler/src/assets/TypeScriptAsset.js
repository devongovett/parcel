const path = require('path');
const Asset = require('../Asset');
const localRequire = require('../utils/localRequire');
const config = require('../utils/config');
const TSCONFIG_FILENAMES = ['tsconfig.json'];

class TypeScriptAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'js';
  }

  async readConfigFile(filepath = this.name, seenConfigPath = new Set()) {
    const tsconfigPath = await config.resolve(filepath, TSCONFIG_FILENAMES);
    if (!tsconfigPath) return;
    if (seenConfigPath.has(tsconfigPath)) {
      // Loop detected
      // This shouldn't happen, but let's silently ignore it?
      return;
    }
    seenConfigPath.add(tsconfigPath);

    // Add as a dependency so it is added to the watcher and invalidates
    // this asset when the config changes.
    this.addDependency(tsconfigPath, {includedInParent: true});

    const {extends: parent, ...tsconfig} = await config.load(
      filepath,
      TSCONFIG_FILENAMES
    );
    if (parent && typeof parent === 'string') {
      const parentConfigPath = path.join(path.dirname(tsconfigPath), parent);
      const parentConfig = await this.readConfigFile(
        parentConfigPath,
        seenConfigPath
      );
      const compilerOptions = Object.assign(
        {},
        parentConfig && parentConfig.compilerOptions,
        tsconfig.compilerOptions
      );
      return Object.assign({}, parentConfig, tsconfig, {
        compilerOptions
      });
    }
    return tsconfig;
  }

  async generate() {
    // require typescript, installed locally in the app
    let typescript = await localRequire('typescript', this.name);
    let transpilerOptions = {
      compilerOptions: {
        module: this.options.scopeHoist
          ? typescript.ModuleKind.ESNext
          : typescript.ModuleKind.CommonJS,
        jsx: typescript.JsxEmit.Preserve,

        // it brings the generated output from TypeScript closer to that generated by Babel
        // see https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-7.html
        esModuleInterop: true
      },
      fileName: this.relativeName
    };

    // Resolve and parse tsconfig.json file
    const tsconfig = await this.readConfigFile();

    // Overwrite default if config is found
    if (tsconfig) {
      Object.assign(
        transpilerOptions.compilerOptions,
        tsconfig.compilerOptions
      );
    }
    transpilerOptions.compilerOptions.noEmit = false;
    transpilerOptions.compilerOptions.sourceMap = this.options.sourceMaps;

    // Transpile Module using TypeScript and parse result as ast format through babylon
    let transpiled = typescript.transpileModule(
      this.contents,
      transpilerOptions
    );
    let sourceMap = transpiled.sourceMapText;

    if (sourceMap) {
      sourceMap = JSON.parse(sourceMap);
      sourceMap.sources = [this.relativeName];
      sourceMap.sourcesContent = [this.contents];

      // Remove the source map URL
      let content = transpiled.outputText;
      transpiled.outputText = content.substring(
        0,
        content.lastIndexOf('//# sourceMappingURL')
      );
    }

    return [
      {
        type: 'js',
        value: transpiled.outputText,
        sourceMap
      }
    ];
  }
}

module.exports = TypeScriptAsset;
