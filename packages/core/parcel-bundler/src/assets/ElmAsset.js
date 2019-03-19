const Asset = require('../Asset');
const commandExists = require('command-exists');
const localRequire = require('../utils/localRequire');
const {minify} = require('terser');
const path = require('path');
const spawn = require('cross-spawn');

class ElmAsset extends Asset {
  constructor(name, options) {
    super(name, options);
    this.type = 'js';
  }

  async parse() {
    let options = {
      cwd: path.dirname(this.name)
    };

    // If elm is not installed globally, install it locally.
    try {
      await commandExists('elm');
    } catch (err) {
      await localRequire('elm', this.name);
      options.pathToElm = path.join(
        path.dirname(require.resolve('elm')),
        'bin',
        'elm'
      );
    }

    this.elm = await localRequire('node-elm-compiler', this.name);

    // Ensure that an elm.json file exists, and initialize one if not.
    let elmConfig = await this.getConfig(['elm.json'], {load: false});
    if (!elmConfig) {
      await this.createElmConfig(options);

      // Ensure we are watching elm.json for changes
      await this.getConfig(['elm.json'], {load: false});
    }

    options.debug = useElmDebugger(
      !this.options.production,
      process.env.PARCEL_ELM_DISABLE_DEBUG
    );
    if (this.options.minify) {
      options.optimize = true;
    }

    this.elmOpts = options;
  }

  async collectDependencies() {
    let dependencies = await this.elm.findAllDependencies(this.name);
    for (let dependency of dependencies) {
      this.addDependency(dependency, {includedInParent: true});
    }
  }

  async createElmConfig(options) {
    let cp = spawn(options.pathToElm || 'elm', ['init']);
    cp.stdin.write('y\n');

    return new Promise((resolve, reject) => {
      cp.on('error', reject);
      cp.on('close', function(code) {
        if (code !== 0) {
          return reject(new Error('elm init failed.'));
        }

        return resolve();
      });
    });
  }

  async generate() {
    let compiled = await this.elm.compileToString(this.name, this.elmOpts);
    this.contents = compiled.toString();
    if (this.options.hmr) {
      let {inject} = await localRequire('elm-hot', this.name);
      this.contents = inject(this.contents);
    }

    let output = this.contents;

    if (this.options.minify) {
      output = pack(output);
    }

    return {
      [this.type]: output
    };

    // Recommended minification
    // Based on:
    // - http://elm-lang.org/0.19.0/optimize
    function pack(source) {
      let options = {
        compress: {
          keep_fargs: false,
          passes: 2,
          pure_funcs: [
            'F2',
            'F3',
            'F4',
            'F5',
            'F6',
            'F7',
            'F8',
            'F9',
            'A2',
            'A3',
            'A4',
            'A5',
            'A6',
            'A7',
            'A8',
            'A9'
          ],
          pure_getters: true,
          unsafe: true,
          unsafe_comps: true
        },
        mangle: true,
        rename: false
      };

      let result = minify(source, options);

      if (result.error) {
        throw result.error;
      }

      return result.code;
    }
  }

  generateErrorMessage(err) {
    // The generated stack is not useful, but other code may
    // expect it and try to print it, so make it an empty string.
    err.stack = '';
    return err;
  }
}

// Use to override the Elm debugger due to a bug in the Elm compiler.
// Reference: https://github.com/parcel-bundler/parcel/issues/2104#issuecomment-461707960
function useElmDebugger(debugValue, environmentOverride) {
  if (environmentOverride) {
    // The value of the environment variable specifies
    // whether to disable the debugger or not.
    // Return true to enable the debugger if the value
    // is something other than '1' or 'true' (case insensitive).
    return !(
      environmentOverride.toLowerCase() === 'true' ||
      environmentOverride === '1'
    );
  }

  // If no override is specified, use the original debug value.
  return debugValue;
}

module.exports = ElmAsset;
