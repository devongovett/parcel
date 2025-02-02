// @flow strict-local
import type {Environment, NamedBundle, PluginOptions} from '@parcel/types';
import {relativePath} from '@parcel/utils';
import path from 'path';

export const prelude = (parcelRequireName: string): string => `
var $parcel$modules = {};
var $parcel$inits = {};

var parcelRequire = $parcel$global[${JSON.stringify(parcelRequireName)}];

if (parcelRequire == null) {
  parcelRequire = function(id) {
    if (id in $parcel$modules) {
      return $parcel$modules[id].exports;
    }
    if (id in $parcel$inits) {
      var init = $parcel$inits[id];
      delete $parcel$inits[id];
      var module = {id: id, exports: {}};
      $parcel$modules[id] = module;
      init.call(module.exports, module, module.exports);
      return module.exports;
    }
    var err = new Error("Cannot find module '" + id + "'");
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  };

  parcelRequire.register = function register(id, init) {
    $parcel$inits[id] = init;
  };

  $parcel$global[${JSON.stringify(parcelRequireName)}] = parcelRequire;
}

var parcelRegister = parcelRequire.register;
`;

export const fnExpr = (
  env: Environment,
  params: Array<string>,
  body: Array<string>,
): string => {
  let block = `{ ${body.join(' ')} }`;

  if (env.supports('arrow-functions')) {
    return `(${params.join(', ')}) => ${block}`;
  }

  return `function (${params.join(', ')}) ${block}`;
};

export const bundleQueuePrelude = (env: Environment): string => `
if (!$parcel$global.lb) {
  // Set of loaded bundles
  $parcel$global.lb = new Set();
  // Queue of bundles to execute once they're dep bundles are loaded
  $parcel$global.bq = [];

  // Register loaded bundle
  $parcel$global.rlb = ${fnExpr(
    env,
    ['bundle'],
    ['$parcel$global.lb.add(bundle);', '$parcel$global.pq();'],
  )}

  // Run when ready
  $parcel$global.rwr = ${fnExpr(
    env,
    // b = bundle public id
    // r = run function to execute the bundle entry
    // d = list of dependent bundles this bundle requires before executing
    ['b', 'r', 'd'],
    ['$parcel$global.bq.push({b, r, d});', '$parcel$global.pq();'],
  )}

  // Process queue
  $parcel$global.pq = ${fnExpr(
    env,
    [],
    [
      `var runnableEntry = $parcel$global.bq.find(${fnExpr(
        env,
        ['i'],
        [
          `return i.d.every(${fnExpr(
            env,
            ['dep'],
            ['return $parcel$global.lb.has(dep);'],
          )});`,
        ],
      )});`,
      'if (runnableEntry) {',
      `$parcel$global.bq = $parcel$global.bq.filter(${fnExpr(
        env,
        ['i'],
        ['return i.b !== runnableEntry.b;'],
      )});`,
      'runnableEntry.r();',
      '$parcel$global.pq();',
      '}',
    ],
  )}
}
`;

const $parcel$export = `
function $parcel$export(e, n, v, s) {
  Object.defineProperty(e, n, {get: v, set: s, enumerable: true, configurable: true});
}
`;

const $parcel$exportWildcard = `
function $parcel$exportWildcard(dest, source) {
  Object.keys(source).forEach(function(key) {
    if (key === 'default' || key === '__esModule' || Object.prototype.hasOwnProperty.call(dest, key)) {
      return;
    }

    Object.defineProperty(dest, key, {
      enumerable: true,
      get: function get() {
        return source[key];
      }
    });
  });

  return dest;
}
`;

const $parcel$interopDefault = `
function $parcel$interopDefault(a) {
  return a && a.__esModule ? a.default : a;
}
`;

const $parcel$global = (env: Environment): string => {
  if (env.supports('global-this')) {
    return `
      var $parcel$global = globalThis;
    `;
  }
  return `
      var $parcel$global =
        typeof globalThis !== 'undefined'
          ? globalThis
          : typeof self !== 'undefined'
          ? self
          : typeof window !== 'undefined'
          ? window
          : typeof global !== 'undefined'
          ? global
          : {};
  `;
};

const $parcel$defineInteropFlag = `
function $parcel$defineInteropFlag(a) {
  Object.defineProperty(a, '__esModule', {value: true, configurable: true});
}
`;

const $parcel$distDir = (env: Environment, bundle: NamedBundle): string => {
  // Generate a relative path from this bundle to the root of the dist dir.
  let distDir = relativePath(path.dirname(bundle.name), '');
  if (!distDir.endsWith('/')) {
    distDir += '/';
  }
  return `var $parcel$distDir = ${JSON.stringify(distDir)};\n`;
};

const $parcel$publicUrl = (env: Environment, bundle: NamedBundle): string => {
  // Ensure the public url always ends with a slash to code can easily join paths to it.
  let publicUrl = bundle.target.publicUrl;
  if (!publicUrl.endsWith('/')) {
    publicUrl += '/';
  }
  return `var $parcel$publicUrl = ${JSON.stringify(publicUrl)};\n`;
};

const $parcel$devServer = (
  env: Environment,
  bundle: NamedBundle,
  _usedHelpers: Set<string>,
  options: PluginOptions,
): string => {
  if (options.hmrOptions) {
    let {host = 'localhost', port} = options.hmrOptions;
    let https = options.serveOptions ? options.serveOptions.https : false;
    port = port ?? (options.serveOptions ? options.serveOptions.port : null);
    if (port != null) {
      let url = (https ? 'https://' : 'http://') + host + ':' + port;
      return `var $parcel$devServer = ${JSON.stringify(url)};\n`;
    }
  }
  return `var $parcel$devServer = null;\n`;
};

const $parcel$extendImportMap = (env: Environment): string => {
  let defineImportMap = env.shouldScopeHoist
    ? 'parcelRequire.i ??= {}'
    : 'importMap';
  return `
function $parcel$extendImportMap(map) {
  Object.assign(${defineImportMap}, map);
}
`;
};

const $parcel$import = (
  env: Environment,
  bundle: NamedBundle,
  usedHelpers: Set<string>,
): string => {
  usedHelpers.add('$parcel$distDir');
  let distDir = env.shouldScopeHoist ? '$parcel$distDir' : 'distDir';
  let importMap = env.shouldScopeHoist ? 'parcelRequire.i?.' : 'importMap';
  return `
function $parcel$import(url) {
  url = ${importMap}[url] || url;
  return import(${distDir} + url);
}
`;
};

const $parcel$resolve = (
  env: Environment,
  bundle: NamedBundle,
  usedHelpers: Set<string>,
): string => {
  let distDir = env.shouldScopeHoist ? '$parcel$distDir' : 'distDir';
  let publicUrl = env.shouldScopeHoist ? '$parcel$publicUrl' : 'publicUrl';
  let importMap = env.shouldScopeHoist ? 'parcelRequire.i?.' : 'importMap';
  if (env.context === 'react-server' || env.context === 'react-client') {
    usedHelpers.add('$parcel$publicUrl');
    return `
function $parcel$resolve(url) {
url = ${importMap}[url] || url;
return ${publicUrl} + url;
}
`;
  } else if (
    env.outputFormat === 'esmodule' &&
    env.supports('import-meta-resolve')
  ) {
    usedHelpers.add('$parcel$distDir');
    return `
function $parcel$resolve(url) {
  url = ${importMap}[url] || url;
  return import.meta.resolve(${distDir} + url);
}
`;
  } else if (
    env.outputFormat === 'esmodule' &&
    env.supports('import-meta-url')
  ) {
    usedHelpers.add('$parcel$distDir');
    return `
function $parcel$resolve(url) {
  url = ${importMap}[url] || url;
  return new URL(${distDir} + url, import.meta.url).toString();
}
`;
  } else if (env.outputFormat === 'commonjs' || env.isNode()) {
    usedHelpers.add('$parcel$distDir');
    return `
function $parcel$resolve(url) {
  url = ${importMap}[url] || url;
  return new URL(${distDir} + url, 'file:' + __filename).toString();
}
`;
  } else {
    usedHelpers.add('$parcel$distDir');
    return `
var $parcel$bundleURL;
function $parcel$resolve(url) {
  url = ${importMap}[url] || url;
  if (!$parcel$bundleURL) {
    try {
      throw new Error();
    } catch (err) {
      var matches = ('' + err.stack).match(
        /(https?|file|ftp|(chrome|moz|safari-web)-extension):\\/\\/[^)\\n]+/g,
      );
      if (matches) {
        $parcel$bundleURL = matches[0];
      } else {
        return ${distDir} + url;
      }
    }
  }
  return new URL(${distDir} + url, $parcel$bundleURL).toString();
}
`;
  }
};

export const helpers = {
  $parcel$export,
  $parcel$exportWildcard,
  $parcel$interopDefault,
  $parcel$global,
  $parcel$defineInteropFlag,
  $parcel$distDir,
  $parcel$publicUrl,
  $parcel$devServer,
  $parcel$extendImportMap,
  $parcel$import,
  $parcel$resolve,
};
