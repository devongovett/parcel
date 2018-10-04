const Asset = require('../Asset');
const localRequire = require('../utils/localRequire');
const config = require('../utils/config');
const fs = require('fs');
const path = require('path');

class TypeScriptAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'js';
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

    let tsconfig = await this.getConfig(['tsconfig.json']);

    // Overwrite default if config is found
    if (tsconfig) {
      // Files read by TypeScript parser while resolving "extends"
      let readFiles = [];
      // https://github.com/Microsoft/TypeScript/blob/62306bc3f9e119dc17b400ff263dad532da6cdb1/scripts/build/upToDate.js#L370
      const parseConfigHost = {
        useCaseSensitiveFileNames: true,
        getCurrentDirectory: () => process.cwd(),
        readDirectory: file => fs.readdirSync(file),
        fileExists: file => fs.existsSync(file) && fs.statSync(file).isFile(),
        readFile: file => {
          readFiles.push(file);
          return fs.readFileSync(file, 'utf8');
        },
        onUnRecoverableConfigFileDiagnostic: () => undefined
      };
      // Get directory of tsconfig.json
      const tsconfigDir = path.dirname(
        await config.resolve(this.name, ['tsconfig.json'])
      );
      // Parse contents of tsconfig.json with TypeScript API to resolve "extends"
      const parsedTsconfig = typescript.parseJsonConfigFileContent(
        tsconfig,
        parseConfigHost,
        tsconfigDir
      );
      // Add resolved files to watch list
      for (const file of readFiles) {
        if (file.endsWith('/tsconfig.json')) {
          this.addDependency(file, {includedInParent: true});
        }
      }
      transpilerOptions.compilerOptions = Object.assign(
        transpilerOptions.compilerOptions,
        parsedTsconfig.options
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
