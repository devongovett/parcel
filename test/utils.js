const Bundler = require('../src/Bundler');
const promisify = require('../src/utils/promisify');
const rimraf = require('rimraf');
const removeDirectory = promisify(rimraf);
const assert = require('assert');
const vm = require('vm');
const fs = require('fs');
const {mkdirp} = require('../src/utils/fs');
const path = require('path');
const WebSocket = require('ws');
const Module = require('module');
const crypto = require('crypto');

let currentTestHash = null;

beforeEach(async function() {
  await clearTmpDirectory();

  currentTestHash = crypto.randomBytes(16).toString('hex');
  await mkdirp(tmpPath());
});

afterEach(async function() {
  currentTestHash = null;
  await clearTmpDirectory();
});

function tmpPath(...args) {
  if (!currentTestHash) {
    throw new Error(
      'tmpPath() has to be called inside a test or in before/after hooks'
    );
  }

  return path.join(__dirname, '..', 'tmp', currentTestHash, ...args);
}

function clearTmpDirectory() {
  return removeDirectory(path.join(__dirname, '..', 'tmp', '*'));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bundler(file, opts) {
  return new Bundler(
    file,
    Object.assign(
      {
        outDir: tmpPath('dist'),
        watch: false,
        cache: false,
        killWorkers: false,
        hmr: false,
        logLevel: 0
      },
      opts
    )
  );
}

function bundle(file, opts) {
  return bundler(file, opts).bundle();
}

function prepareBrowserContext(bundle, globals) {
  // for testing dynamic imports
  const fakeElement = {
    remove() {}
  };

  const fakeDocument = {
    createElement(tag) {
      return {tag};
    },

    getElementsByTagName() {
      return [
        {
          appendChild(el) {
            setTimeout(function() {
              if (el.tag === 'script') {
                vm.runInContext(fs.readFileSync(tmpPath('dist', el.src)), ctx);
              }

              el.onload();
            }, 0);
          }
        }
      ];
    },

    getElementById() {
      return fakeElement;
    },

    body: {
      appendChild() {
        return null;
      }
    }
  };

  var ctx = Object.assign(
    {
      document: fakeDocument,
      WebSocket,
      console,
      location: {hostname: 'localhost'},
      fetch(url) {
        return Promise.resolve({
          arrayBuffer() {
            return Promise.resolve(
              new Uint8Array(fs.readFileSync(tmpPath('dist', url))).buffer
            );
          }
        });
      }
    },
    globals
  );

  ctx.window = ctx;
  return ctx;
}

function prepareNodeContext(bundle, globals) {
  var mod = new Module(bundle.name);
  mod.paths = [path.dirname(bundle.name) + '/node_modules'];

  var ctx = Object.assign(
    {
      module: mod,
      __filename: bundle.name,
      __dirname: path.dirname(bundle.name),
      require: function(path) {
        return mod.require(path);
      },
      console,
      process: process,
      setTimeout: setTimeout,
      setImmediate: setImmediate
    },
    globals
  );

  ctx.global = ctx;
  return ctx;
}

function run(bundle, globals, opts = {}) {
  var ctx;
  switch (bundle.entryAsset.options.target) {
    case 'browser':
      ctx = prepareBrowserContext(bundle, globals);
      break;
    case 'node':
      ctx = prepareNodeContext(bundle, globals);
      break;
    case 'electron':
      ctx = Object.assign(
        prepareBrowserContext(bundle, globals),
        prepareNodeContext(bundle, globals)
      );
      break;
  }

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(bundle.name), ctx);

  if (opts.require !== false) {
    return ctx.parcelRequire(bundle.entryAsset.id);
  }

  return ctx;
}

function assertBundleTree(bundle, tree) {
  if (tree.name) {
    assert.equal(path.basename(bundle.name), tree.name);
  }

  if (tree.type) {
    assert.equal(bundle.type.toLowerCase(), tree.type.toLowerCase());
  }

  if (tree.assets) {
    assert.deepEqual(
      Array.from(bundle.assets)
        .map(a => a.basename)
        .sort(),
      tree.assets.sort()
    );
  }

  if (tree.childBundles) {
    let children = Array.from(bundle.childBundles).sort(
      (a, b) =>
        Array.from(a.assets).sort()[0].basename <
        Array.from(b.assets).sort()[0].basename
          ? -1
          : 1
    );
    assert.equal(bundle.childBundles.size, tree.childBundles.length);
    tree.childBundles.forEach((b, i) => assertBundleTree(children[i], b));
  }

  if (/js|css/.test(bundle.type)) {
    assert(fs.existsSync(bundle.name));
  }
}

function nextBundle(b) {
  return new Promise(resolve => {
    b.once('bundled', resolve);
  });
}

function deferred() {
  let resolve, reject;
  let promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  promise.resolve = resolve;
  promise.reject = reject;

  return promise;
}

exports.removeDirectory = removeDirectory;
exports.tmpPath = tmpPath;
exports.sleep = sleep;
exports.bundler = bundler;
exports.bundle = bundle;
exports.run = run;
exports.assertBundleTree = assertBundleTree;
exports.nextBundle = nextBundle;
exports.deferred = deferred;
