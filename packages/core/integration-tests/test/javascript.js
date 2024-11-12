import assert from 'assert';
import path from 'path';
import url from 'url';
import {
  assertDependencyWasExcluded,
  bundle,
  bundler,
  findAsset,
  findDependency,
  getNextBuild,
  run,
  runBundle,
  runBundles,
  assertBundles,
  ncp,
  overlayFS,
  removeDistDirectory,
  distDir,
  outputFS,
  inputFS,
  fsFixture,
} from '@parcel/test-utils';
import {makeDeferredWithPromise, normalizePath} from '@parcel/utils';
import vm from 'vm';
import Logger from '@parcel/logger';
import nullthrows from 'nullthrows';
import {md} from '@parcel/diagnostic';

describe('javascript', function () {
  beforeEach(async () => {
    await removeDistDirectory();
  });

  it('should produce a basic JS bundle with CommonJS requires', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/commonjs/index.js'),
    );

    // assert.equal(b.assets.size, 8);
    // assert.equal(b.childBundles.size, 1);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should support url: imports with CommonJS output', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/commonjs-import-url/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'esmodule-helpers.js'],
      },
      {
        type: 'txt',
        assets: ['x.txt'],
      },
    ]);

    let txtBundle = b.getBundles().find(b => b.type === 'txt').filePath;

    let output = await run(b);
    assert.strictEqual(path.basename(output), path.basename(txtBundle));
  });

  it('should produce a basic JS bundle with ES6 imports', async function () {
    let b = await bundle(path.join(__dirname, '/integration/es6/index.js'), {
      outputFS: inputFS,
    });

    // assert.equal(b.assets.size, 8);
    // assert.equal(b.childBundles.size, 1);

    let output = await run(b);
    assert.equal(typeof output, 'object');
    assert.equal(typeof output.default, 'function');
    assert.equal(output.default(), 3);
  });

  it('should detect dependencies inserted by a prior transform', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/dependency-prior-transform/index.js'),
    );

    let jsBundle = b.getBundles()[0];
    let contents = await outputFS.readFile(jsBundle.filePath);

    assert(!contents.includes('import'));
  });

  it('should ignore unused requires after process.env inlining', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-unused-require/index.js'),
      {
        env: {ABC: 'XYZ'},
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('unused'));

    let output = await run(b);
    assert.strictEqual(output(), 'ok');
  });

  it('should produce a basic JS bundle with object rest spread support', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/object-rest-spread/object-rest-spread.js',
      ),
    );

    // assert.equal(b.assets.size, 1);

    let output = await run(b);
    assert.equal(typeof output, 'object');
    assert.equal(typeof output.default, 'function');

    let res = output.default();
    assert.equal(res.y, 'a');
    assert.deepEqual(res.z, {y: 'a', b: 'b'});
    assert.deepEqual(res.ys, {b: 'b'});
  });

  it('should bundle node_modules for a browser environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/node_require_browser/main.js'),
    );

    assertBundles(b, [
      {
        name: 'main.js',
        assets: ['main.js', 'local.js', 'index.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should not bundle node_modules for a node environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/node_require/main.js'),
    );

    assertBundles(b, [
      {
        name: 'main.js',
        assets: ['main.js', 'local.js'],
      },
    ]);

    await outputFS.mkdirp(path.join(distDir, 'node_modules/testmodule'));
    await outputFS.writeFile(
      path.join(distDir, 'node_modules/testmodule/index.js'),
      'exports.a = 5;',
    );

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 7);
  });

  it.skip('should not bundle node_modules on --target=electron', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/node_require/main.js'),
      {
        target: 'electron',
      },
    );

    assertBundles(b, {
      name: 'main.js',
      assets: ['main.js', 'local.js'],
    });

    await outputFS.mkdirp(path.join(distDir, 'node_modules/testmodule'));
    await outputFS.writeFile(
      path.join(distDir, 'node_modules/testmodule/index.js'),
      'exports.a = 5;',
    );

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 7);
  });

  it('should preserve hashbangs in bundles and preserve executable file mode', async () => {
    let fixturePath = path.join(__dirname, '/integration/node_hashbang');
    await bundle(path.join(fixturePath, 'main.js'));

    let mainPath = path.join(fixturePath, 'dist', 'node', 'main.js');
    let main = await outputFS.readFile(mainPath, 'utf8');
    assert.equal(main.lastIndexOf('#!/usr/bin/env node\n'), 0);
    assert.equal(
      (await outputFS.stat(mainPath)).mode,
      (await inputFS.stat(path.join(fixturePath, 'main.js'))).mode,
    );
    await outputFS.rimraf(path.join(fixturePath, 'dist'));
  });

  it('should not preserve hashbangs in browser bundles', async () => {
    let fixturePath = path.join(__dirname, '/integration/node_hashbang');
    await bundle(path.join(fixturePath, 'main.js'));

    let main = await outputFS.readFile(
      path.join(fixturePath, 'dist', 'browser', 'main.js'),
      'utf8',
    );
    assert(!main.includes('#!/usr/bin/env node\n'));
    await outputFS.rimraf(path.join(fixturePath, 'dist'));
  });

  it('should preserve hashbangs in scopehoisted bundles', async () => {
    let fixturePath = path.join(__dirname, '/integration/node_hashbang');
    await bundle(path.join(__dirname, '/integration/node_hashbang/main.js'), {
      defaultTargetOptions: {
        shouldScopeHoist: true,
      },
    });

    let main = await outputFS.readFile(
      path.join(fixturePath, 'dist', 'node', 'main.js'),
      'utf8',
    );
    assert.equal(main.lastIndexOf('#!/usr/bin/env node\n'), 0);
    await outputFS.rimraf(path.join(fixturePath, 'dist'));
  });

  it('should bundle node_modules for a node environment if includeNodeModules is specified', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/include_node_modules/main.js'),
    );

    assertBundles(b, [
      {
        name: 'main.js',
        assets: ['main.js', 'local.js', 'index.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should bundle builtins for a browser environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/include_builtins-browser/main.js'),
    );

    assertBundles(b, [
      {
        name: 'main.js',
        assets: [
          '_empty.js',
          'browser.js',
          'esmodule-helpers.js',
          'index.js',
          'main.js',
        ],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    let [fs, filepath] = output();
    assert.equal(filepath, path.posix.join('app', 'index.js'));
    assert.equal(typeof fs, 'object');
    assert.deepEqual(Object.keys(fs), Object.keys({}));
  });

  it('should not bundle builtins for a node environment if includeNodeModules is specified', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/include_builtins-node/main.js'),
    );

    assertBundles(b, [
      {
        name: 'main.js',
        assets: ['esmodule-helpers.js', 'main.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    let [fs, filepath] = output();
    assert.equal(filepath, path.join('app', 'index.js'));
    assert.equal(typeof fs.readFile, 'function');
  });

  it.skip('should bundle node_modules on --target=electron and --bundle-node-modules', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/node_require/main.js'),
      {
        target: 'electron',
        bundleNodeModules: true,
      },
    );

    assertBundles(b, {
      name: 'main.js',
      assets: ['main.js', 'local.js', 'index.js'],
    });

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should produce a JS bundle with default exports and no imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/es6-default-only/index.js'),
    );

    // assert.equal(b.assets.size, 1);
    // assert.equal(b.childBundles.size, 1);

    let output = await run(b);
    assert.equal(typeof output, 'object');
    assert.equal(typeof output.default, 'function');
    assert.equal(output.default(), 3);
  });

  it('should split bundles when a dynamic import is used a browser environment', async function () {
    let b = await bundle(path.join(__dirname, '/integration/dynamic/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        assets: ['local.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should prefetch bundles when declared as an import attribute statically', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-static-prefetch/index.js'),
    );

    let output = await run(b);
    let headChildren = await output.default;

    assert.strictEqual(headChildren.length, 4);

    assert.strictEqual(headChildren[1].tag, 'script');
    assert(headChildren[1].src.match(/async\..*\.js/));

    assert.strictEqual(headChildren[2].tag, 'link');
    assert.strictEqual(headChildren[2].rel, 'prefetch');
    assert.strictEqual(headChildren[2].as, 'script');
    assert(headChildren[2].href.match(/prefetched\..*\.js/));

    assert.strictEqual(headChildren[3].tag, 'link');
    assert.strictEqual(headChildren[3].rel, 'prefetch');
    assert.strictEqual(headChildren[3].as, 'style');
    assert(headChildren[3].href.match(/prefetched\..*\.css/));
  });

  it('should load additional links that were prefetched', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/dynamic-static-prefetch-loaded/index.js',
      ),
    );

    let output = await run(b);
    let outputReturn = await output.default;
    await outputReturn.loadDependency();

    let headChildren = outputReturn.children;
    assert.equal(headChildren.length, 7);
    let cssBundles = headChildren.filter(child =>
      child.href?.match(/prefetched-loaded\..*\.css/),
    );
    assert.equal(cssBundles.length, 2);

    assert(cssBundles[0].tag === 'link');
    assert(cssBundles[0].rel === 'prefetch');
    assert(cssBundles[0].as === 'style');
    assert(cssBundles[0].href.match(/prefetched-loaded\..*\.css/));

    assert(cssBundles[1].tag === 'link');
    assert(cssBundles[1].rel === 'stylesheet');
    assert(cssBundles[1].href.match(/prefetched-loaded\..*\.css/));
  });

  it('should preload bundles when declared as an import attribute statically', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-static-preload/index.js'),
    );

    let output = await run(b);
    let headChildren = await output.default;

    assert(headChildren.length === 4);

    assert(headChildren[2].tag === 'link');
    assert(headChildren[2].rel === 'preload');
    assert(headChildren[2].as === 'script');
    assert(headChildren[2].href.match(/preloaded\..*\.js/));

    assert(headChildren[3].tag === 'link');
    assert(headChildren[3].rel === 'preload');
    assert(headChildren[3].as === 'style');
    assert(headChildren[3].href.match(/preloaded\..*\.css/));
  });

  // TODO: Implement when we can evaluate bundles against esmodule targets
  it(
    'targetting esmodule, should modulepreload bundles when declared as an import attribute statically',
  );

  it('should remove import attributes', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-import-attributes/index.js'),
    );

    let mainBundle = b.getBundles()[0];
    let mainBundleContent = await outputFS.readFile(
      mainBundle.filePath,
      'utf8',
    );
    assert(!mainBundleContent.includes('foo:'));
  });

  it('should split bundles when a dynamic import is used with a node environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-node/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        assets: ['local.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should split bundles when a dynamic import is used with an electron-main environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-electron-main/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        assets: ['local.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should split bundles when a dynamic import is used with an electron-renderer environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-electron-renderer/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        assets: ['local.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it.skip('should load dynamic bundle when entry is in a subdirectory', async function () {
    let bu = await bundler(
      path.join(
        __dirname,
        '/integration/dynamic-subdirectory/subdirectory/index.js',
      ),
      {
        target: 'browser',
      },
    );
    // Set the rootDir to make sure subdirectory is preserved
    bu.options.rootDir = path.join(
      __dirname,
      '/integration/dynamic-subdirectory',
    );
    let b = await bu.bundle();
    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  // TODO: re-enable when this actually works
  it.skip('Should not run parcel over external modules', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-external/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['esmodule-helpers.js', 'index.js'],
      },
    ]);
  });

  it('dynamic imports loaded as high-priority scripts when not all engines support esmodules natively', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-imports-high-prio/index.js'),
      {
        defaultTargetOptions: {
          engines: {
            browsers: 'IE 11',
          },
        },
      },
    );

    let output = await run(b);
    let headChildren = await output.default;

    assert(headChildren[0].tag === 'link');
    assert(headChildren[0].rel === 'preload');
    assert(headChildren[0].as === 'script');

    assert(headChildren[1].tag === 'script');
    assert(headChildren[1].src.match(/async\..*\.js/));

    assert(headChildren[0].href === headChildren[1].src);
  });

  it('should deduplicate and remove an unnecessary async bundle when it contains a cyclic reference to its entry', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/deduplicate-from-async-cyclic-bundle-entry/index.js',
      ),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bar.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'foo.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.deepEqual(await Promise.all((await run(b)).default), [5, 4]);
  });

  it('does not create bundles for dynamic imports when assets are available up the graph', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/internalize-no-bundle-split/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bar.js', 'foo.js', 'esmodule-helpers.js'],
      },
    ]);

    assert.deepEqual(await (await run(b)).default, [3, 3]);
  });

  it('should dynamic import files which import raw files', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-references-raw/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        assets: ['local.js', 'esmodule-helpers.js'],
      },
      {
        assets: ['test.txt'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should return all exports as an object when using ES modules', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-esm/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['local.js'],
      },
    ]);

    let output = (await run(b)).default;
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should duplicate small modules across multiple bundles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-common-small/index.js'),
    );

    assertBundles(b, [
      {
        assets: ['a.js', 'common.js', 'common-dep.js'],
      },
      {
        assets: ['b.js', 'common.js', 'common-dep.js'],
      },
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'cacheLoader.js', 'js-loader.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 7);
  });

  it('should create a separate bundle for large modules shared between bundles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-common-large/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
      },
    );

    assertBundles(b, [
      {
        assets: ['a.js'],
      },
      {
        assets: ['b.js'],
      },
      {
        name: 'index.js',
        assets: [
          'index.js',
          'c.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['common.js', 'lodash.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 7);
  });

  it('should not duplicate a module which is already in a parent bundle', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-hoist-dup/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'common.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['a.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 5);
  });

  it('should duplicate an asset if it is not present in every parent bundle', async function () {
    let b = await bundle(
      ['a.js', 'b.js'].map(entry =>
        path.join(__dirname, 'integration/dynamic-hoist-no-dedupe', entry),
      ),
    );
    assertBundles(b, [
      {
        assets: ['c.js', 'common.js', 'esmodule-helpers.js'],
      },
      {
        name: 'b.js',
        assets: ['b.js', 'bundle-url.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        name: 'a.js',
        assets: [
          'a.js',
          'bundle-url.js',
          'common.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
        ],
      },
    ]);
  });

  it('should duplicate an asset if it is not available in all possible ancestries', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/dynamic-hoist-no-dedupe-ancestry/index.js',
      ),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'esmodule-helpers.js',
        ],
      },
      {
        assets: ['a.js', 'common.js'],
      },
      {
        assets: ['b.js'],
      },
      {
        assets: ['c.js'],
      },
      {
        assets: ['d.js', 'common.js'],
      },
    ]);

    let {default: promise} = await run(b);
    assert.equal(await promise, 42);
  });

  it('should support shared modules with async imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-hoist-deep/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['a.js', 'c.js'],
      },
      {
        assets: ['b.js', 'c.js'],
      },
      {
        assets: ['1.js'],
      },
    ]);

    let {default: promise} = await run(b);
    assert.ok(await promise);
  });

  it('should support requiring JSON files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/json/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.json'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should support requiring JSON5 files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/json5/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.json5'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should support importing a URL to a raw asset', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/import-raw/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js'],
      },
      {
        type: 'txt',
        assets: ['test.txt'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert(/^http:\/\/localhost\/test\.[0-9a-f]+\.txt$/.test(output()));
    let stats = await outputFS.stat(
      path.join(distDir, url.parse(output()).pathname),
    );
    assert.equal(stats.size, 9);
  });

  it('should support referencing a raw asset with static URL and import.meta.url', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/import-raw-import-meta-url/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'esmodule-helpers.js'],
      },
      {
        type: 'txt',
        assets: ['test.txt'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('import.meta.url'));

    let output = await run(b);
    assert(/^http:\/\/localhost\/test\.[0-9a-f]+\.txt$/.test(output.default));
    let stats = await outputFS.stat(
      path.join(distDir, output.default.pathname),
    );
    assert.equal(stats.size, 9);
  });

  it('should support referencing a raw asset with static URL and CJS __filename', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/import-raw-import-meta-url/cjs.js'),
    );

    assertBundles(b, [
      {
        name: 'cjs.js',
        assets: ['cjs.js', 'bundle-url.js', 'esmodule-helpers.js'],
      },
      {
        type: 'txt',
        assets: ['test.txt'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('import.meta.url'));

    let output = await run(b);
    assert(/^http:\/\/localhost\/test\.[0-9a-f]+\.txt$/.test(output.default));
    let stats = await outputFS.stat(
      path.join(distDir, output.default.pathname),
    );
    assert.equal(stats.size, 9);
  });

  it('should ignore new URL and import.meta.url with local binding', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/import-raw-import-meta-url/local-url.js',
      ),
    );

    assertBundles(b, [
      {
        name: 'local-url.js',
        assets: ['esmodule-helpers.js', 'local-url.js'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(contents.includes('"file:///local-url.js"'));
  });

  it('should throw a codeframe for a missing raw asset with static URL and import.meta.url', async function () {
    let fixture = path.join(
      __dirname,
      'integration/import-raw-import-meta-url/missing.js',
    );
    let code = await inputFS.readFileSync(fixture, 'utf8');
    await assert.rejects(() => bundle(fixture), {
      name: 'BuildError',
      diagnostics: [
        {
          codeFrames: [
            {
              filePath: fixture,
              code,
              codeHighlights: [
                {
                  message: undefined,
                  end: {
                    column: 36,
                    line: 1,
                  },
                  start: {
                    column: 24,
                    line: 1,
                  },
                },
              ],
            },
          ],
          message: "Failed to resolve 'invalid.txt' from './missing.js'",
          origin: '@parcel/core',
        },
        {
          hints: [],
          message: "Cannot load file './invalid.txt' in './'.",
          origin: '@parcel/resolver-default',
        },
      ],
    });
  });

  it('should support importing a URL to a large raw asset', async function () {
    // 6 megabytes, which exceeds the threshold in summarizeRequest for buffering
    // entire contents into memory and should stream content instead
    let assetSizeBytes = 6000000;

    let distDir = path.join(outputFS.cwd(), '/dist');
    let fixtureDir = path.join(__dirname, '/integration/import-raw');
    let inputDir = path.join(__dirname, 'input');

    await ncp(fixtureDir, inputDir);
    await outputFS.writeFile(
      path.join(inputDir, 'test.txt'),
      Buffer.alloc(assetSizeBytes),
    );

    let b = await bundle(path.join(inputDir, 'index.js'), {
      inputFS: overlayFS,
      defaultTargetOptions: {
        distDir,
      },
    });
    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js'],
      },
      {
        type: 'txt',
        assets: ['test.txt'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert(/^http:\/\/localhost\/test\.[0-9a-f]+\.txt$/.test(output()));
    let stats = await outputFS.stat(
      path.join(distDir, url.parse(output()).pathname),
    );
    assert.equal(stats.size, assetSizeBytes);
  });

  it('should minify JS in production mode', async function () {
    let b = await bundle(path.join(__dirname, '/integration/uglify/index.js'), {
      defaultTargetOptions: {
        shouldOptimize: true,
        shouldScopeHoist: false,
      },
    });

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);

    let js = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(!js.includes('local.a'));
  });

  it('should use terser config', async function () {
    await bundle(path.join(__dirname, '/integration/terser-config/index.js'), {
      defaultTargetOptions: {
        shouldOptimize: true,
        shouldScopeHoist: false,
      },
    });

    let js = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(!js.includes('console.log'));
    assert(!js.includes('// This is a comment'));
  });

  it('should insert global variables when needed', async function () {
    let b = await bundle(path.join(__dirname, '/integration/globals/index.js'));

    let output = await run(b);
    assert.deepEqual(output(), {
      dir: 'integration/globals',
      file: 'integration/globals/index.js',
      buf: Buffer.from('browser').toString('base64'),
      global: true,
    });
  });

  it('should replace __dirname and __filename with path relative to asset.filePath', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-node-replacements/index.js'),
    );

    let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      dist.includes(
        'resolve(__dirname, "../test/integration/env-node-replacements")',
      ),
    );
    assert(
      dist.includes(
        'resolve(__dirname, "../test/integration/env-node-replacements/other")',
      ),
    );
    assert(
      dist.includes(
        'resolve(__dirname, "../test/integration/env-node-replacements", "index.js")',
      ),
    );
    assert(
      dist.includes(
        'resolve(__dirname, "../test/integration/env-node-replacements/sub")',
      ),
    );
    assert(
      dist.includes(
        'resolve(__dirname, "../test/integration/env-node-replacements/sub", "index.js")',
      ),
    );
    let f = await run(b);
    let output = f();
    assert.equal(output.data, 'hello');
    assert.equal(output.other, 'hello');
    assert.equal(
      output.firstDirnameTest,
      path.join(__dirname, '/integration/env-node-replacements/data'),
    );
    assert.equal(
      output.secondDirnameTest,
      path.join(__dirname, '/integration/env-node-replacements/other-data'),
    );
    assert.equal(
      output.firstFilenameTest,
      path.join(__dirname, '/integration/env-node-replacements/index.js'),
    );
    assert.equal(
      output.secondFilenameTest,
      path.join(
        __dirname,
        '/integration/env-node-replacements/index.js?query-string=test',
      ),
    );
    assert.equal(
      output.sub.dirname,
      path.join(__dirname, '/integration/env-node-replacements/sub'),
    );
    assert.equal(
      output.sub.filename,
      path.join(__dirname, '/integration/env-node-replacements/sub/index.js'),
    );
  });

  it('should replace __dirname and __filename with path relative to asset.filePath with scope hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-node-replacements/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
      },
    );

    let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      dist.includes(
        'path.resolve(__dirname, "../test/integration/env-node-replacements")',
      ),
    );
    assert(
      dist.includes(
        'path.resolve(__dirname, "../test/integration/env-node-replacements/other")',
      ),
    );
    assert(
      dist.includes(
        'path.resolve(__dirname, "../test/integration/env-node-replacements", "index.js")',
      ),
    );
    assert(
      dist.includes(
        'path.resolve(__dirname, "../test/integration/env-node-replacements/sub")',
      ),
    );
    assert(
      dist.includes(
        'path.resolve(__dirname, "../test/integration/env-node-replacements/sub", "index.js")',
      ),
    );
    let f = await run(b);
    let output = f();
    assert.equal(output.data, 'hello');
    assert.equal(output.other, 'hello');
    assert.equal(
      output.firstDirnameTest,
      path.join(__dirname, '/integration/env-node-replacements/data'),
    );
    assert.equal(
      output.secondDirnameTest,
      path.join(__dirname, '/integration/env-node-replacements/other-data'),
    );
    assert.equal(
      output.firstFilenameTest,
      path.join(__dirname, '/integration/env-node-replacements/index.js'),
    );
    assert.equal(
      output.secondFilenameTest,
      path.join(
        __dirname,
        '/integration/env-node-replacements/index.js?query-string=test',
      ),
    );
    assert.equal(
      output.sub.dirname,
      path.join(__dirname, '/integration/env-node-replacements/sub'),
    );
    assert.equal(
      output.sub.filename,
      path.join(__dirname, '/integration/env-node-replacements/sub/index.js'),
    );
  });

  it('should work when multiple files use globals with scope hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/globals/multiple.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
      },
    );

    let output = await run(b);
    assert.deepEqual(output, {
      file: 'integration/globals/multiple.js',
      other: 'integration/globals/index.js',
    });
  });

  it('should not insert global variables when used in a module specifier', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/globals-module-specifier/a.js'),
    );

    assertBundles(b, [
      {
        assets: ['a.js', 'b.js', 'c.js', 'esmodule-helpers.js'],
      },
    ]);

    let output = await run(b);
    assert.deepEqual(output, 1234);
  });

  it('should not insert global variables in dead branches', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/globals-unused/a.js'),
    );

    assertBundles(b, [
      {
        assets: ['a.js'],
      },
    ]);

    let output = await run(b);
    assert.deepEqual(output, 'foo');
  });

  it('should handle re-declaration of the global constant', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/global-redeclare/index.js'),
    );

    let output = await run(b);
    assert.deepEqual(output(), false);
  });

  it('should insert environment variables inserted by a prior transform', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/env-prior-transform/index.js'),
    );

    let jsBundle = b.getBundles()[0];
    let contents = await outputFS.readFile(jsBundle.filePath, 'utf8');

    assert(!contents.includes('process.env'));
    assert.equal(await run(b), 'test');
  });

  it('should not insert environment variables in node environment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-node/index.js'),
    );

    let output = await run(b);
    assert.ok(output.toString().includes('process.env'));
    assert.equal(output(), 'test:test');
  });

  it('should not replace process.env.hasOwnProperty with undefined', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-hasOwnProperty/index.js'),
    );

    let output = await run(b);
    assert.strictEqual(output, false);
  });

  it('should not insert environment variables in electron-main environment', async function () {
    let b = await bundle(path.join(__dirname, '/integration/env/index.js'), {
      targets: {
        main: {
          context: 'electron-main',
          distDir: path.join(__dirname, '/integration/env/dist.js'),
        },
      },
    });

    let output = await run(b);
    assert.ok(output.toString().includes('process.env'));
    assert.equal(output(), 'test:test');
  });

  it('should not insert environment variables in electron-renderer environment', async function () {
    let b = await bundle(path.join(__dirname, '/integration/env/index.js'), {
      targets: {
        main: {
          context: 'electron-renderer',
          distDir: path.join(__dirname, '/integration/env/dist.js'),
        },
      },
    });

    let output = await run(b);
    assert.ok(output.toString().includes('process.env'));
    assert.equal(output(), 'test:test');
  });

  it('should inline NODE_ENV environment variable in browser environment even if disabled', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-nodeenv/index.js'),
      {
        env: {
          FOO: 'abc',
        },
      },
    );

    let output = await run(b);
    assert.ok(!output.toString().includes('process.env'));
    assert.equal(output(), 'test:undefined');
  });

  it('should not insert environment variables in browser environment if disabled', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-disabled/index.js'),
      {
        env: {FOOBAR: 'abc'},
      },
    );

    let output = await run(b);
    assert.ok(!output.toString().includes('process.env'));
    assert.equal(output(), 'undefined:undefined:undefined');
  });

  it('should only insert environment variables in browser environment matching the glob', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-disabled-glob/index.js'),
      {
        env: {A_1: 'abc', B_1: 'def', B_2: 'ghi'},
      },
    );

    let output = await run(b);
    assert.ok(!output.toString().includes('process.env'));
    assert.equal(output(), 'undefined:def:ghi');
  });

  it('should be able to inline environment variables in browser environment', async function () {
    let b = await bundle(path.join(__dirname, '/integration/env/index.js'), {
      env: {NODE_ENV: 'abc'},
    });

    let output = await run(b);
    assert.ok(!output.toString().includes('process.env'));
    assert.equal(output(), 'abc:abc');
  });

  it("should insert the user's NODE_ENV as process.env.NODE_ENV if passed", async function () {
    let b = await bundle(path.join(__dirname, '/integration/env/index.js'), {
      env: {
        NODE_ENV: 'production',
      },
    });

    let output = await run(b);
    assert.ok(!output.toString().includes('process.env'));
    assert.equal(output(), 'production:production');
  });

  it('should not inline computed accesses to process.env', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-computed/index.js'),
      {
        env: {ABC: 'abc'},
      },
    );

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(contents.includes('process.env'));

    let output = await run(b);
    assert.strictEqual(output, undefined);
  });

  it('should inline computed accesses with string literals to process.env', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-computed-string/index.js'),
      {
        env: {ABC: 'XYZ'},
      },
    );

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('process.env'));

    let output = await run(b);
    assert.strictEqual(output, 'XYZ');
  });

  it('should inline environment variables when destructured in a variable declaration', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-destructuring/index.js'),
      {
        env: {TEST: 'XYZ'},
        defaultTargetOptions: {
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('process.env'));

    let output = await run(b);
    assert.deepEqual(output, {
      env: {},
      NODE_ENV: 'test',
      renamed: 'XYZ',
      computed: undefined,
      fallback: 'yo',
      rest: {},
      other: 'hi',
    });
  });

  it('should inline environment variables when destructured in an assignment', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-destructuring/assign.js'),
      {
        env: {TEST: 'XYZ'},
        defaultTargetOptions: {
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('process.env'));

    let output = await run(b);
    assert.deepEqual(output, {
      env: {},
      NODE_ENV: 'test',
      renamed: 'XYZ',
      computed: undefined,
      fallback: 'yo',
      rest: {},
      result: {},
    });
  });

  it('should inline environment variables with in binary expression whose right branch is process.env and left branch is string literal', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-binary-in-expression/index.js'),
      {
        env: {ABC: 'any'},
        defaultTargetOptions: {
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('process.env'));

    let output = await run(b);
    assert.deepEqual(output, {
      existVar: 'correct',
      notExistVar: 'correct',
    });
  });

  it('should insert environment variables from a file', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-file/index.js'),
    );

    // Make sure dotenv doesn't leak its values into the main process's env
    assert(process.env.FOO == null);

    let output = await run(b);
    assert.equal(output, 'bartest');
  });

  it("should insert environment variables matching the user's NODE_ENV if passed", async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-file/index.js'),
      {env: {NODE_ENV: 'production'}},
    );

    let output = await run(b);
    assert.equal(output, 'productiontest');
  });

  it('should overwrite environment variables from a file if passed', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-file/index.js'),
      {env: {BAR: 'baz'}},
    );

    let output = await run(b);
    assert.equal(output, 'barbaz');
  });

  it('should insert environment variables from a file even if entry file is specified with source value in package.json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/env-file-with-package-source'),
    );

    let output = await run(b);
    assert.equal(output, 'bartest');
  });

  it('should error on process.env mutations', async function () {
    let filePath = path.join(__dirname, '/integration/env-mutate/index.js');
    await assert.rejects(bundle(filePath), {
      diagnostics: [
        {
          origin: '@parcel/transformer-js',
          message: 'Mutating process.env is not supported',
          hints: null,
          codeFrames: [
            {
              filePath,
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 1,
                    column: 1,
                  },
                  end: {
                    line: 1,
                    column: 29,
                  },
                },
              ],
            },
          ],
        },
        {
          origin: '@parcel/transformer-js',
          message: 'Mutating process.env is not supported',
          hints: null,
          codeFrames: [
            {
              filePath,
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 2,
                    column: 1,
                  },
                  end: {
                    line: 2,
                    column: 30,
                  },
                },
              ],
            },
          ],
        },
        {
          origin: '@parcel/transformer-js',
          message: 'Mutating process.env is not supported',
          hints: null,
          codeFrames: [
            {
              filePath,
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 3,
                    column: 1,
                  },
                  end: {
                    line: 3,
                    column: 28,
                  },
                },
              ],
            },
          ],
        },
        {
          origin: '@parcel/transformer-js',
          message: 'Mutating process.env is not supported',
          hints: null,
          codeFrames: [
            {
              filePath,
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 4,
                    column: 1,
                  },
                  end: {
                    line: 4,
                    column: 23,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('should warn on process.env mutations in node_modules', async function () {
    let logs = [];
    let disposable = Logger.onLog(d => {
      if (d.level !== 'verbose') {
        logs.push(d);
      }
    });
    let b = await bundle(
      path.join(__dirname, '/integration/env-mutate/warn.js'),
    );
    disposable.dispose();

    assert.deepEqual(logs, [
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/transformer-js',
            message: 'Mutating process.env is not supported',
            hints: null,
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  '/integration/env-mutate/node_modules/foo/index.js',
                ),
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 8,
                    },
                    end: {
                      line: 1,
                      column: 36,
                    },
                  },
                ],
              },
            ],
          },
          {
            origin: '@parcel/transformer-js',
            message: 'Mutating process.env is not supported',
            hints: null,
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  '/integration/env-mutate/node_modules/foo/index.js',
                ),
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 2,
                      column: 8,
                    },
                    end: {
                      line: 2,
                      column: 35,
                    },
                  },
                ],
              },
            ],
          },
          {
            origin: '@parcel/transformer-js',
            message: 'Mutating process.env is not supported',
            hints: null,
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  '/integration/env-mutate/node_modules/foo/index.js',
                ),
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 3,
                      column: 8,
                    },
                    end: {
                      line: 3,
                      column: 30,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    let output = [];
    await run(b, {
      output(o) {
        output.push(o);
      },
    });
    assert.deepEqual(output, ['foo', true, undefined]);
  });

  it('should replace process.browser for target browser', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/process/index.js'),
      {
        targets: {
          main: {
            context: 'browser',
            distDir: path.join(__dirname, '/integration/process/dist.js'),
          },
        },
      },
    );

    let output = await run(b);
    assert.ok(output.toString().indexOf('process.browser') === -1);
    assert.equal(output(), true);
  });

  it('should not touch process.browser for target node', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/process/index.js'),
      {
        targets: {
          main: {
            context: 'node',
            distDir: path.join(__dirname, '/integration/process/dist.js'),
          },
        },
      },
    );

    let output = await run(b);
    assert.ok(output.toString().indexOf('process.browser') !== -1);
    assert.equal(output(), false);
  });

  it('should not touch process.browser for target electron-main', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/process/index.js'),
      {
        targets: {
          main: {
            context: 'electron-main',
            distDir: path.join(__dirname, '/integration/process/dist.js'),
          },
        },
      },
    );

    let output = await run(b);
    assert.ok(output.toString().indexOf('process.browser') !== -1);
    assert.equal(output(), false);
  });

  it('should replace process.browser for target electron-renderer', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/process/index.js'),
      {
        targets: {
          main: {
            context: 'electron-renderer',
            distDir: path.join(__dirname, '/integration/process/dist.js'),
          },
        },
      },
    );

    let output = await run(b);
    assert.ok(output.toString().indexOf('process.browser') === -1);
    assert.equal(output(), true);
    // Running the bundled code has the side effect of setting process.browser = true, which can mess
    // up the instantiation of typescript.sys within validator-typescript, so we want to reset it.
    process.browser = undefined;
  });

  it.skip('should support adding implicit dependencies', async function () {
    let b = await bundle(path.join(__dirname, '/integration/json/index.js'), {
      delegate: {
        getImplicitDependencies(asset) {
          if (asset.basename === 'index.js') {
            return [{name: '../css/index.css'}];
          }
        },
      },
    });

    assertBundles(b, {
      name: 'index.js',
      assets: ['index.js', 'local.json', 'index.css'],
      childBundles: [
        {
          type: 'css',
          assets: ['index.css'],
        },
        {
          type: 'map',
        },
      ],
    });

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should support requiring YAML files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/yaml/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.yaml'],
        childBundles: [
          {
            type: 'map',
          },
        ],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should support requiring TOML files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/toml/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.toml'],
        childBundles: [
          {
            type: 'map',
          },
        ],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should support requiring CoffeeScript files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/coffee/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.coffee'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);
  });

  it('should resolve the browser field before main', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/browser.js'),
    );

    assertBundles(b, [
      {
        name: 'browser.js',
        assets: ['browser.js', 'browser-module.js', 'esmodule-helpers.js'],
      },
    ]);

    let output = await run(b);

    assert.equal(typeof output.test, 'function');
    assert.equal(output.test(), 'pkg-browser');
  });

  it('should exclude resolving specifiers that map to false in the browser field in browser builds', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/resolve-entries/pkg-ignore-browser/index.js',
      ),
      {
        targets: ['browsers'],
      },
    );

    assert.deepEqual(await run(b), {});
  });

  it('should not exclude resolving specifiers that map to false in the browser field in node builds', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/resolve-entries/pkg-ignore-browser/index.js',
      ),
      {
        targets: ['node'],
      },
    );

    assert.equal(await run(b), 'this should only exist in non-browser builds');
  });

  it.skip('should not resolve the browser field for --target=node', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/browser.js'),
      {
        target: 'node',
      },
    );

    assertBundles(b, {
      name: 'browser.js',
      assets: ['browser.js', 'node-module.js'],
      childBundles: [
        {
          type: 'map',
        },
      ],
    });

    let output = await run(b);

    assert.equal(typeof output.test, 'function');
    assert.equal(output.test(), 'pkg-main');
  });

  it.skip('should resolve advanced browser resolution', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/browser-multiple.js'),
    );

    assertBundles(b, {
      name: 'browser-multiple.js',
      assets: [
        'browser-multiple.js',
        'projected-browser.js',
        'browser-entry.js',
      ],
      childBundles: [
        {
          type: 'map',
        },
      ],
    });

    let {test: output} = await run(b);

    assert.equal(typeof output.projected.test, 'function');
    assert.equal(typeof output.entry.test, 'function');
    assert.equal(output.projected.test(), 'pkg-browser-multiple');
    assert.equal(output.entry.test(), 'pkg-browser-multiple browser-entry');
  });

  it.skip('should not resolve advanced browser resolution with --target=node', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/browser-multiple.js'),
      {
        target: 'node',
      },
    );

    assertBundles(b, {
      name: 'browser-multiple.js',
      assets: ['browser-multiple.js', 'node-entry.js', 'projected.js'],
      childBundles: [
        {
          type: 'map',
        },
      ],
    });

    let {test: output} = await run(b);

    assert.equal(typeof output.projected.test, 'function');
    assert.equal(typeof output.entry.test, 'function');
    assert.equal(output.projected.test(), 'pkg-main-multiple');
    assert.equal(output.entry.test(), 'pkg-browser-multiple main-entry');
  });

  it.skip('should resolve the module field before main if scope-hoisting is enabled', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/module-field.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'module-field.js',
        assets: ['module-field.js', 'es6.module.js'],
      },
    ]);

    let output = await run(b);

    assert.equal(typeof output.test, 'function');
    assert.equal(output.test(), 'pkg-es6-module');
  });

  it.skip('should resolve the module field before main if scope-hoisting is enabled', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/both-fields.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'both-fields.js',
        assets: ['both-fields.js', 'es6.module.js'],
      },
    ]);

    let output = await run(b);

    assert.equal(typeof output.test, 'function');
    assert.equal(output.test(), 'pkg-es6-module');
  });

  it('should resolve the main field', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-entries/main-field.js'),
    );

    assertBundles(b, [
      {
        name: 'main-field.js',
        assets: ['main-field.js', 'main.js', 'esmodule-helpers.js'],
      },
    ]);

    let output = await run(b);

    assert.equal(typeof output.test, 'function');
    assert.equal(output.test(), 'pkg-main-module');
  });

  it('should minify JSON files', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/uglify-json/index.json'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
          shouldScopeHoist: false,
        },
      },
    );

    let json = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(json.includes('{"test":"test"}'));

    let output = await run(b);
    assert.deepEqual(output, {test: 'test'});
  });

  it('should minify JSON5 files', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/uglify-json5/index.json5'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
          shouldScopeHoist: false,
        },
      },
    );

    let json = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(json.includes('{"test":"test"}'));

    let output = await run(b);
    assert.deepEqual(output, {test: 'test'});
  });

  it.skip('should minify YAML for production', async function () {
    let b = await bundle(path.join(__dirname, '/integration/yaml/index.js'), {
      defaultTargetOptions: {
        shouldOptimize: true,
        shouldScopeHoist: false,
      },
    });

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);

    let json = await outputFS.readFile('dist/index.js', 'utf8');
    assert(json.includes('{a:1,b:{c:2}}'));
  });

  it('should minify TOML for production', async function () {
    let b = await bundle(path.join(__dirname, '/integration/toml/index.js'), {
      defaultTargetOptions: {
        shouldOptimize: true,
        shouldScopeHoist: false,
      },
    });

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);

    let json = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(json.includes('{a:1,b:{c:2}}'));
  });

  it('should support optional dependencies in try...catch blocks', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/optional-dep/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
    ]);

    let output = await run(b);

    assert.equal(Object.getPrototypeOf(output).constructor.name, 'Error');
    assert(
      /Cannot find module ['"]optional-dep['"]/.test(output.message),
      'Should set correct error message',
    );
    assert.equal(output.code, 'MODULE_NOT_FOUND');
  });

  it('should support excluding dependencies in falsy branches', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/falsy-dep/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'true-alternate.js', 'true-consequent.js'],
      },
    ]);

    let output = await run(b);
    assert.equal(output, 2);
  });

  it.skip('should not autoinstall if resolve failed on installed module', async function () {
    let error;
    try {
      await bundle(
        path.join(
          __dirname,
          '/integration/dont-autoinstall-resolve-fails/index.js',
        ),
      );
    } catch (err) {
      error = err;
    }
    assert.equal(
      error.message,
      `Cannot resolve dependency 'vue/thisDoesNotExist'`,
    );
    assert.equal(error.code, 'MODULE_NOT_FOUND');
  });

  it.skip('should not autoinstall if resolve failed on aliased module', async function () {
    let error;
    try {
      await bundle(
        path.join(
          __dirname,
          '/integration/dont-autoinstall-resolve-alias-fails/index.js',
        ),
      );
    } catch (err) {
      error = err;
    }
    assert.equal(
      error.message,
      `Cannot resolve dependency 'aliasVue/thisDoesNotExist'`,
    );
    assert.equal(error.code, 'MODULE_NOT_FOUND');
  });

  it('should ignore require if it is defined in the scope', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/require-scope/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
    ]);

    let output = await run(b);

    assert.equal(typeof output.test, 'object');

    let failed = Object.keys(output.test).some(
      key => output.test[key] !== 'test passed',
    );

    assert.equal(failed, false);
  });

  it('should expose to CommonJS entry point', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/entry-point/index.js'),
    );

    let module = {};
    await run(b, {module, exports: {}});
    assert.equal(module.exports(), 'Test!');
  });

  it('should expose to RequireJS entry point', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/entry-point/index.js'),
    );
    let test;
    const mockDefine = function (f) {
      test = f();
    };
    mockDefine.amd = true;

    await run(b, {define: mockDefine, module: undefined});
    assert.equal(test(), 'Test!');
  });

  it.skip('should expose variable with --browser-global', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/entry-point/index.js'),
      {
        global: 'testing',
      },
    );

    const ctx = await run(b, {module: undefined}, {require: false});
    assert.equal(ctx.window.testing(), 'Test!');
  });

  it.skip('should set `define` to undefined so AMD checks in UMD modules do not pass', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/define-amd/index.js'),
    );
    let test;
    const mockDefine = function (f) {
      test = f();
    };
    mockDefine.amd = true;

    await run(b, {define: mockDefine, module: undefined});
    assert.equal(test, 2);
  });

  it('should package successfully with comments on last line', async function () {
    let b = await bundle(
      path.join(__dirname, `/integration/js-comment/index.js`),
    );

    let output = await run(b);
    assert.equal(output, 'Hello World!');
  });

  it('should package successfully with comments on last line and minification', async function () {
    let b = await bundle(
      path.join(__dirname, `/integration/js-comment/index.js`),
    );

    let output = await run(b);
    assert.equal(output, 'Hello World!');
  });

  it('should package successfully with comments on last line and scope hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, `/integration/js-comment/index.js`),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    let output = await run(b);
    assert.equal(output, 'Hello World!');
  });

  it('should package successfully with comments on last line, scope hoisting and minification', async function () {
    let b = await bundle(
      path.join(__dirname, `/integration/js-comment/index.js`),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: true,
        },
      },
    );

    let output = await run(b);
    assert.equal(output, 'Hello World!');
  });

  it('should not replace toplevel this with undefined in CommonJS without scope-hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/js-this-commonjs/a.js'),
    );

    let output;
    function result(v) {
      output = v;
    }
    await run(b, {result});
    assert.deepEqual(output, [{foo: 2}, 1234]);
  });

  it('should not replace toplevel this with undefined in CommonJS when scope-hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/js-this-commonjs/a.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    let output;
    function result(v) {
      output = v;
    }
    await run(b, {result});
    assert.deepEqual(output, [{foo: 2}, 1234]);
  });

  it('should replace toplevel this with undefined in ESM without scope-hoisting', async function () {
    let b = await bundle(path.join(__dirname, '/integration/js-this-es6/a.js'));

    let output;
    function result(v) {
      output = v;
    }
    await run(b, {result});
    assert.deepEqual(output, [undefined, 1234]);
  });

  it('should replace toplevel this with undefined in ESM when scope-hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/js-this-es6/a.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    let output;
    function result(v) {
      output = v;
    }
    await run(b, {result});
    assert.deepEqual(output, [undefined, 1234]);
  });

  it.skip('should not dedupe imports with different contents', async function () {
    let b = await bundle(
      path.join(__dirname, `/integration/js-different-contents/index.js`),
      {
        hmr: false, // enable asset dedupe in JSPackager
      },
    );

    let module = await run(b);
    assert.equal(module.default, 'Hello World!');
  });

  it.skip('should not dedupe imports with same content but different absolute dependency paths', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        `/integration/js-same-contents-different-dependencies/index.js`,
      ),
      {
        hmr: false, // enable asset dedupe in JSPackager
      },
    );

    let module = await run(b);
    assert.equal(module.default, 'Hello World!');
  });

  it.skip('should dedupe imports with same content and same dependency paths', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        `/integration/js-same-contents-same-dependencies/index.js`,
      ),
      {
        hmr: false, // enable asset dedupe in JSPackager
      },
    );
    const {rootDir} = b.entryAsset.options;
    const writtenAssets = Array.from(b.offsets.keys()).map(asset => asset.name);
    assert.equal(writtenAssets.length, 2);
    assert(writtenAssets.includes(path.join(rootDir, 'index.js')));
    assert(
      writtenAssets.includes(path.join(rootDir, 'hello1.js')) ||
        writtenAssets.includes(path.join(rootDir, 'hello2.js')),
    );
    assert(
      !(
        writtenAssets.includes(path.join(rootDir, 'hello1.js')) &&
        writtenAssets.includes(path.join(rootDir, 'hello2.js'))
      ),
    );

    let module = await run(b);
    assert.equal(module.default, 'Hello Hello!');
  });

  it.skip('should not dedupe assets that exist in more than one bundle', async function () {
    let b = await bundle(
      path.join(__dirname, `/integration/js-dedup-hoist/index.js`),
      {
        hmr: false, // enable asset dedupe in JSPackager
      },
    );
    const {rootDir} = b.entryAsset.options;
    const writtenAssets = Array.from(b.offsets.keys()).map(asset => asset.name);
    assert(
      writtenAssets.includes(path.join(rootDir, 'hello1.js')) &&
        writtenAssets.includes(path.join(rootDir, 'hello2.js')),
    );

    let module = await run(b);
    assert.equal(await module.default(), 'Hello Hello! Hello');
  });

  it.skip('should support importing HTML from JS async', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/import-html-async/index.js'),
      {
        defaultTargetOptions: {
          sourceMaps: false,
        },
      },
    );

    assertBundles(b, {
      name: 'index.js',
      assets: ['index.js', 'cacheLoader.js', 'html-loader.js'],
      childBundles: [
        {
          type: 'html',
          assets: ['other.html'],
          childBundles: [
            {
              type: 'png',
              assets: ['100x100.png'],
              childBundles: [],
            },
            {
              type: 'css',
              assets: ['index.css'],
            },
          ],
        },
      ],
    });

    let output = await run(b);
    assert.equal(typeof output, 'string');
    assert(output.includes('<html>'));
    assert(output.includes('Other page'));
  });

  it.skip('should support importing HTML from JS async with --target=node', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/import-html-async/index.js'),
      {
        target: 'node',
        defaultTargetOptions: {
          sourceMaps: false,
        },
      },
    );

    assertBundles(b, {
      name: 'index.js',
      assets: ['index.js', 'cacheLoader.js', 'html-loader.js'],
      childBundles: [
        {
          type: 'html',
          assets: ['other.html'],
          childBundles: [
            {
              type: 'png',
              assets: ['100x100.png'],
              childBundles: [],
            },
            {
              type: 'css',
              assets: ['index.css'],
            },
          ],
        },
      ],
    });

    let output = await run(b);
    assert.equal(typeof output, 'string');
    assert(output.includes('<html>'));
    assert(output.includes('Other page'));
  });

  it.skip('should support importing HTML from JS sync', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/import-html-sync/index.js'),
      {
        defaultTargetOptions: {
          sourceMaps: false,
        },
      },
    );

    assertBundles(b, {
      name: 'index.js',
      assets: ['index.js', 'cacheLoader.js', 'html-loader.js'],
      childBundles: [
        {
          type: 'html',
          assets: ['other.html'],
          childBundles: [
            {
              type: 'png',
              assets: ['100x100.png'],
              childBundles: [],
            },
            {
              type: 'css',
              assets: ['index.css'],
            },
          ],
        },
      ],
    });

    let {deferred, promise} = makeDeferredWithPromise();
    await run(b, {output: deferred.resolve}, {require: false});
    let output = await promise;
    assert.equal(typeof output, 'string');
    assert(output.includes('<html>'));
    assert(output.includes('Other page'));
  });

  it.skip('should stub require.cache', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/node_require_cache/main.js'),
      {
        target: 'node',
      },
    );

    await run(b);
  });

  it('should support async importing the same module from different bundles', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/shared-bundlegroup/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['a.js'],
      },
      {
        assets: ['b.js'],
      },
      {
        assets: ['c.js'],
      },
    ]);

    let {default: promise} = await run(b);
    assert.deepEqual(await promise, ['hello from a test', 'hello from b test']);
  });

  it('should not create shared bundles from contents of entries', async () => {
    let b = await bundle(
      ['a.js', 'b.js'].map(entry =>
        path.join(
          __dirname,
          '/integration/no-shared-bundles-from-entries/',
          entry,
        ),
      ),
    );

    assertBundles(b, [
      {
        name: 'a.js',
        assets: ['a.js', 'esmodule-helpers.js', 'lodash.js'],
      },
      {
        name: 'b.js',
        assets: ['b.js', 'esmodule-helpers.js', 'lodash.js'],
      },
    ]);
  });

  it('should import the same dependency multiple times in the same bundle', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/same-dependency-multiple-times/a1.js'),
    );

    await run(b);
  });

  it("should inline a bundle's compiled text with `bundle-text`", async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/index.js'),
    );

    let cssBundleContent = (await run(b)).default;

    assert(
      cssBundleContent.startsWith(
        `body {
  background-color: #000;
}

.svg-img {
  background-image: url("data:image/svg+xml,%3Csvg%3E%0A%0A%3C%2Fsvg%3E%0A");
}`,
      ),
    );

    assert(!cssBundleContent.includes('sourceMappingURL'));
  });

  it('should not include the runtime manifest for `bundle-text`', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          shouldOptimize: false,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'index.js',
        type: 'js',
        assets: ['esmodule-helpers.js', 'index.js'],
      },
      {
        type: 'svg',
        assets: ['img.svg'],
      },
      {
        type: 'css',
        assets: ['text.scss'],
      },
    ]);

    let cssBundleContent = (await run(b)).default;

    assert(
      cssBundleContent.startsWith(
        `body {
  background-color: #000;
}

.svg-img {
  background-image: url("data:image/svg+xml,%3Csvg%3E%0A%0A%3C%2Fsvg%3E%0A");
}`,
      ),
    );

    assert(!cssBundleContent.includes('sourceMappingURL'));
  });

  it("should inline an HTML bundle's compiled text with `bundle-text`", async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/index.html'),
    );

    let res = await run(b);
    assert.equal(res.default, '<p>test</p>\n');
  });

  it('should inline an HTML bundle and inline scripts with `bundle-text`', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/inline.js'),
    );

    let res = await run(b);
    assert.equal(
      res.default,
      `<p>test</p>\n<script>console.log('hi');\n\n</script>\n`,
    );
  });

  it("should inline a JS bundle's compiled text with `bundle-text` and HMR enabled", async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/javascript.js'),
      {
        hmrOptions: {},
      },
    );

    let res = await run(b);
    let log;
    let ctx = vm.createContext({
      console: {
        log(x) {
          log = x;
        },
      },
    });
    vm.runInContext(res.default, ctx);
    assert.equal(log, 'hi');
  });

  it("should inline a JS bundle's compiled text with `bundle-text` with symbol propagation", async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/javascript.js'),
      {
        mode: 'production',
      },
    );

    let res = await run(b);
    let log;
    let ctx = vm.createContext({
      console: {
        log(x) {
          log = x;
        },
      },
    });
    vm.runInContext(res, ctx);
    assert.equal(log, 'hi');
  });

  it("should inline a bundle's compiled text with `bundle-text` asynchronously", async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/bundle-text/async.js'),
    );

    let promise = (await run(b)).default;
    assert.equal(typeof promise.then, 'function');

    let cssBundleContent = await promise;

    assert(
      cssBundleContent.startsWith(
        `body {
  background-color: #000;
}

.svg-img {
  background-image: url("data:image/svg+xml,%3Csvg%3E%0A%0A%3C%2Fsvg%3E%0A");
}`,
      ),
    );

    assert(!cssBundleContent.includes('sourceMappingURL'));
  });

  it('should inline text content as url-encoded text and mime type with `data-url:*` imports', async () => {
    let b = await bundle(path.join(__dirname, '/integration/data-url/text.js'));

    assert.equal(
      (await run(b)).default,
      'data:image/svg+xml,%3Csvg%20width%3D%22120%22%20height%3D%22120%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Cfilter%20id%3D%22blur-_.%21~%2a%22%3E%0A%20%20%20%20%3CfeGaussianBlur%20stdDeviation%3D%225%22%3E%3C%2FfeGaussianBlur%3E%0A%20%20%3C%2Ffilter%3E%0A%20%20%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2250%22%20fill%3D%22green%22%20filter%3D%22url%28%27%23blur-_.%21~%2a%27%29%22%3E%3C%2Fcircle%3E%0A%3C%2Fsvg%3E%0A',
    );
  });

  it('should inline binary content as url-encoded base64 and mime type with `data-url:*` imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/data-url/binary.js'),
    );
    ``;

    assert((await run(b)).default.startsWith('data:image/webp;base64,UklGR'));
  });

  it('should support both pipeline and non-pipeline imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/multi-pipeline/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'esmodule-helpers.js'],
      },
      {
        name: 'index.css',
        assets: ['style.css'],
      },
      {
        type: 'css',
        assets: ['style.css'],
      },
    ]);

    assert((await run(b)).default.startsWith('.test'));
  });

  it('should detect typescript style async requires in commonjs', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/ts.js'),
    );

    assertBundles(b, [
      {
        name: 'ts.js',
        assets: ['ts.js', 'bundle-url.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.equal(await run(b), 2);
  });

  it('should detect typescript style async requires in commonjs with esModuleInterop flag', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/ts-interop.js'),
    );

    assertBundles(b, [
      {
        name: 'ts-interop.js',
        assets: [
          'ts-interop.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.deepEqual(await run(b), {default: 2});

    let jsBundle = b.getBundles()[0];
    let contents = await outputFS.readFile(jsBundle.filePath, 'utf8');
    assert(
      /.then\(function\(res\) {\n.*return __importStar\(res\)/.test(contents),
    );
  });

  it('should detect typescript style async requires in commonjs with esModuleInterop flag and arrow functions', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/ts-interop-arrow.js'),
    );

    assertBundles(b, [
      {
        name: 'ts-interop-arrow.js',
        assets: [
          'ts-interop-arrow.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.deepEqual(await run(b), {default: 2});

    let jsBundle = b.getBundles()[0];
    let contents = await outputFS.readFile(jsBundle.filePath, 'utf8');
    assert(/.then\(\(res\)=>__importStar\(res\)/.test(contents));
  });

  it('should detect rollup style async requires in commonjs', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/rollup.js'),
    );

    assertBundles(b, [
      {
        name: 'rollup.js',
        assets: [
          'rollup.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.equal(await run(b), 2);
  });

  it('should only detect requires that are returned from the promise', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/sync.js'),
    );

    assertBundles(b, [
      {
        name: 'sync.js',
        assets: ['sync.js', 'async.js'],
      },
    ]);

    assert.equal(await run(b), 5);
  });

  it('should properly chain a dynamic import wrapped in a Promise.resolve()', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/resolve-chain.js'),
    );

    assertBundles(b, [
      {
        name: 'resolve-chain.js',
        assets: [
          'resolve-chain.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.equal(await run(b), 1337);
  });

  it('should detect parcel style async requires in commonjs', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/require-async/parcel.js'),
    );

    assertBundles(b, [
      {
        name: 'parcel.js',
        assets: [
          'parcel.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    assert.equal(await run(b), 2);
  });

  it('should detect requires in commonjs with plain template literals', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/commonjs-template-literal-plain/index.js',
      ),
    );
    let dist = await outputFS.readFile(
      b.getBundles().find(b => b.type === 'js').filePath,
      'utf8',
    );
    assert(dist.includes('$cPUKg$lodash = require("lodash");'));

    let add = await run(b);
    assert.equal(add(2, 3), 5);
  });

  it(`should detect requires in commonjs with plain template literals`, async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/commonjs-template-literal-interpolation/index.js',
      ),
    );
    let dist = await outputFS.readFile(
      b.getBundles().find(b => b.type === 'js').filePath,
      'utf8',
    );

    assert(
      dist.includes(
        'const add = require(`lodash/${$8cad8166811e0063$var$fn}`);',
      ),
    );

    let add = await run(b);
    assert.equal(add(2, 3), 5);
  });

  it('only updates bundle names of changed bundles for browsers', async () => {
    let fixtureDir = path.join(__dirname, '/integration/name-invalidation');
    let _bundle = () =>
      bundle(path.join(fixtureDir, 'index.js'), {
        inputFS: overlayFS,
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          shouldOptimize: false,
        },
      });

    let first = await _bundle();
    assert.equal(await (await run(first)).default, 42);

    let bPath = path.join(fixtureDir, 'b.js');
    await overlayFS.mkdirp(fixtureDir);
    overlayFS.writeFile(
      bPath,
      (await overlayFS.readFile(bPath, 'utf8')).replace('42', '43'),
    );

    let second = await _bundle();
    assert.equal(await (await run(second)).default, 43);

    let getBundleNameWithPrefix = (b, prefix) =>
      b
        .getBundles()
        .map(bundle => path.basename(bundle.filePath))
        .find(name => name.startsWith(prefix));

    assert.equal(
      getBundleNameWithPrefix(first, 'a'),
      getBundleNameWithPrefix(second, 'a'),
    );
    assert.notEqual(
      getBundleNameWithPrefix(first, 'b'),
      getBundleNameWithPrefix(second, 'b'),
    );
  });

  it('can load the same resource when referenced in multiple bundles', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/same-resource-multiple-bundles/index.js',
      ),
    );

    let res = await run(b);
    assert(url.parse(await res.default()).pathname.startsWith('/resource'));
  });

  it('can static import and dynamic import in the same bundle without creating a new bundle', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/sync-async/same-bundle.js'),
      {mode: 'production', defaultTargetOptions: {shouldScopeHoist: false}},
    );

    assertBundles(b, [
      {
        name: 'same-bundle.js',
        assets: [
          'same-bundle.js',
          'get-dep.js',
          'get-dep-2.js',
          'dep.js',
          'esmodule-helpers.js',
        ],
      },
    ]);

    assert.deepEqual(await (await run(b)).default, [42, 42, 42]);
  });

  it('async dependency can be resolved internally and externally from two different bundles', async () => {
    let b = await bundle(
      ['entry1.js', 'entry2.js'].map(entry =>
        path.join(
          __dirname,
          '/integration/async-dep-internal-external/',
          entry,
        ),
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        assets: ['async.js'],
      },
      {
        name: 'entry1.js',
        assets: ['child.js', 'entry1.js', 'async.js'],
      },
      {
        name: 'entry2.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'child.js',
          'entry2.js',
          'js-loader.js',
        ],
      },
    ]);
  });

  it('can static import and dynamic import in the same bundle ancestry without creating a new bundle', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/sync-async/same-ancestry.js'),
      {mode: 'production', defaultTargetOptions: {shouldScopeHoist: false}},
    );

    assertBundles(b, [
      {
        name: 'same-ancestry.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'dep.js',
          'js-loader.js',
          'same-ancestry.js',
          'esmodule-helpers.js',
        ],
      },
      {
        assets: ['get-dep.js'],
      },
    ]);

    assert.deepEqual(await (await run(b)).default, [42, 42]);
  });

  it('can static import and dynamic import in the same bundle when another bundle requires async', async () => {
    let b = await bundle(
      ['same-bundle.js', 'get-dep.js'].map(entry =>
        path.join(__dirname, '/integration/sync-async/', entry),
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
      },
    );

    assertBundles(b, [
      {
        assets: ['dep.js'],
      },
      {
        name: 'same-bundle.js',
        assets: [
          'same-bundle.js',
          'get-dep.js',
          'get-dep-2.js',
          'dep.js',
          'esmodule-helpers.js',
        ],
      },
      {
        name: 'get-dep.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'get-dep.js',
          'js-loader.js',
          'esmodule-helpers.js',
        ],
      },
    ]);

    let bundles = b.getBundles();
    let sameBundle = bundles.find(b => b.name === 'same-bundle.js');
    let getDep = bundles.find(b => b.name === 'get-dep.js');

    assert.deepEqual(
      await (
        await runBundle(b, sameBundle)
      ).default,
      [42, 42, 42],
    );
    assert.deepEqual(await (await runBundle(b, getDep)).default, 42);
  });

  it("can share dependencies between a shared bundle and its sibling's descendants", async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/shared-exports-for-sibling-descendant/index.js',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
      },
    );

    assertBundles(b, [
      {
        assets: ['wraps.js', 'lodash.js'],
      },
      {
        assets: ['a.js'],
      },
      {
        assets: ['child.js'],
      },
      {
        assets: ['grandchild.js'],
      },
      {
        assets: ['b.js'],
      },
      {
        name: 'index.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'index.js',
          'js-loader.js',
          'esmodule-helpers.js',
        ],
      },
    ]);

    assert.deepEqual(await (await run(b)).default, [3, 5]);
  });

  it('can run an entry bundle whose entry asset is present in another bundle', async () => {
    let b = await bundle(
      ['index.js', 'value.js'].map(basename =>
        path.join(__dirname, '/integration/sync-entry-shared', basename),
      ),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'esmodule-helpers.js',
        ],
      },
      {name: 'value.js', assets: ['value.js', 'esmodule-helpers.js']},
      {assets: ['async.js']},
    ]);

    assert.equal(await (await run(b)).default, 43);
  });

  it('can run an async bundle whose entry asset is present in another bundle', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/async-entry-shared/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'esmodule-helpers.js',
        ],
      },
      {assets: ['value.js']},
      {assets: ['async.js']},
    ]);

    assert.deepEqual(await (await run(b)).default, [42, 43]);
  });

  it('should display a codeframe on a Terser parse error', async () => {
    let fixture = path.join(__dirname, 'integration/terser-codeframe/index.js');
    let code = await inputFS.readFileSync(fixture, 'utf8');
    await assert.rejects(
      () =>
        bundle(fixture, {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: '`let` cannot be used as an identifier in strict mode',
            origin: '@parcel/optimizer-swc',
            codeFrames: [
              {
                filePath: undefined,
                language: 'js',
                code,
                codeHighlights: [
                  {
                    start: {
                      column: 1,
                      line: 1,
                    },
                    end: {
                      column: 1,
                      line: 1,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  });

  it('can run an async bundle that depends on a nonentry asset in a sibling', async () => {
    let b = await bundle(
      ['index.js', 'other-entry.js'].map(basename =>
        path.join(
          __dirname,
          '/integration/async-entry-shared-sibling',
          basename,
        ),
      ),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'esmodule-helpers.js',
        ],
      },
      {
        name: 'other-entry.js',
        assets: [
          'other-entry.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {assets: ['a.js', 'value.js', 'esmodule-helpers.js']},
      {assets: ['b.js']},
    ]);

    assert.deepEqual(await (await run(b)).default, 43);
  });

  it('can share sibling bundles reachable from a common dependency', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/shared-sibling-common-dependency/index.js',
      ),
    );

    let bundles = b.getBundles();
    let asyncJsBundles = bundles.filter(
      b => !b.needsStableName && b.type === 'js',
    );
    assert.equal(asyncJsBundles.length, 2);

    // Every bundlegroup with an async js bundle should have the corresponding css
    for (let bundle of asyncJsBundles) {
      for (let bundleGroup of b.getBundleGroupsContainingBundle(bundle)) {
        let bundlesInGroup = b.getBundlesInBundleGroup(bundleGroup);
        assert(bundlesInGroup.find(s => s.type === 'css'));
      }
    }
  });

  it('should throw a diagnostic for unknown pipelines', async function () {
    let fixture = path.join(__dirname, 'integration/pipeline-unknown/a.js');
    let code = await inputFS.readFileSync(fixture, 'utf8');
    await assert.rejects(() => bundle(fixture), {
      name: 'BuildError',
      diagnostics: [
        {
          message: "Failed to resolve 'strange-pipeline:./b.js' from './a.js'",
          origin: '@parcel/core',
          codeFrames: [
            {
              filePath: fixture,
              code,
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    column: 19,
                    line: 1,
                  },
                  end: {
                    column: 43,
                    line: 1,
                  },
                },
              ],
            },
          ],
        },
        {
          message: "Unknown url scheme or pipeline 'strange-pipeline:'",
          origin: '@parcel/resolver-default',
        },
      ],
    });
  });

  it('can create a bundle starting with a dot', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/dotfile-bundle/index.js'),
    );

    assertBundles(b, [
      {
        name: '.output.js',
        assets: ['index.js'],
      },
    ]);
  });

  it('should not automatically name bundle files starting with a dot', async function () {
    await bundle(
      path.join(__dirname, '/integration/bundle-naming/.invisible/index.js'),
    );
    let bundleFiles = await outputFS.readdir(distDir);
    let renamedSomeFiles = bundleFiles.some(currFile =>
      currFile.startsWith('invisible.'),
    );
    let namedWithDot = bundleFiles.some(currFile =>
      currFile.startsWith('.invisible.'),
    );
    assert.equal(renamedSomeFiles, true);
    assert.equal(namedWithDot, false);
  });

  it('should support duplicate re-exports without scope hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-duplicate-re-exports/index.js'),
    );
    let res = await run(b);
    assert.equal(res.a, 'a');
    assert.equal(res.b, 'b');
    assert.equal(typeof res.c, 'function');
  });

  it('should prioritize named exports before re-exports withput scope hoisting (before)', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/scope-hoisting/es6/re-export-priority/entry-a.mjs',
      ),
    );

    let res = await run(b, null, {require: false});
    assert.equal(res.output, 2);
  });

  it('should prioritize named exports before re-exports without scope hoisting (after)', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/scope-hoisting/es6/re-export-priority/entry-b.mjs',
      ),
    );

    let res = await run(b, null, {require: false});
    assert.equal(res.output, 2);
  });

  it('should exclude default from export all declaration', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-all/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {a: 4});
  });

  it('should not use arrow functions for reexport declarations unless supported', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-arrow-support/index.js'),
      {
        // Remove comments containing "=>"
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );
    let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!content.includes('=>'));
  });

  it('should support import namespace declarations of other ES modules', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-namespace/a.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {a: 4, default: 1});
  });

  it('should support import namespace declarations of class from CJS', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-namespace/b.js'),
    );
    let res = await run(b);
    assert.equal(typeof res, 'function');
  });

  it('should support import namespace declarations of object from CJS', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-namespace/c.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {foo: 2, default: 3});
  });

  it('should support export namespace declarations', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-namespace/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {ns: {a: 4, default: 1}});
  });

  it('should support export declarations with destructuring', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-destructuring/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {foo: 1, bar: 2});
  });

  it('should support export default declarations', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-default/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {other: 1});
  });

  it('should hoist function default exports to allow circular imports', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/js-export-default-fn-circular-named/a.mjs',
      ),
    );

    let output;
    function result(v) {
      output = v;
    }
    await run(b, {result});
    assert.deepEqual(output, 'b1');
  });

  it('should hoist anonymous function default exports to allow circular imports', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/js-export-default-fn-circular-anonymous/a.mjs',
      ),
    );

    let output;
    function result(v) {
      output = v;
    }
    await run(b, {result});
    assert.deepEqual(output, 'b1');
  });

  it('should work with many different types of exports', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-many/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {
      foo: 'foo',
      bar: 'bar',
      default: 'baz',
      boo: 'boo',
      foobar: 'foobar',
      type1: 'type1',
      type2: 'type2',
    });
  });

  it('should correctly export functions', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-functions/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(Object.keys(res), ['foo', 'bar']);
    assert.strictEqual(res.foo('test'), 'foo:test');
    assert.strictEqual(res.bar('test'), 'bar:test');
  });

  it('should handle exports of imports', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-import/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {other: 2});
  });

  it('should handle simultaneous import and reexports of the same identifier', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-export-import-same/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, {foo: '123', bar: '1234'});
  });

  it('should generate a unique variable name for imports', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-shadow/index.js'),
    );
    let res = await run(b);
    assert.strictEqual(res.baz(), 'foo');
  });

  it('should not replace identifier with a var declaration inside a for loop', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-shadow-for-var/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res.baz(), [0, 1, 2, 3]);
  });

  it('should replace an imported identifier with function locals of the same name', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-shadow-func-var/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res.default, 123);
  });

  it('should replace imported values in member expressions', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-member/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res.default, ['a', 'b', 'bar']);
  });

  it('should retain the correct dependency order between import and reexports', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-reexport-dep-order/index.js'),
    );

    let calls = [];
    await run(b, {
      sideEffect(v) {
        calls.push(v);
      },
    });
    assert.deepEqual(calls, ['a', 'b', 'c']);
  });

  it('should not freeze live default imports', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-default-live/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res.default, [123, 789]);
  });

  it('should not rewrite this in arrow function class properties', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-class-this-esm/a.js'),
    );
    let res = await run(b);
    assert.deepEqual(res.default, 'x: 123');
  });

  it('should call named imports without this context', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-this/index.js'),
    );
    let res = await run(b, {output: null}, {strict: true});
    assert.deepEqual(res.default, {
      unwrappedNamed: [true, false],
      unwrappedDefault: [true, false],
      unwrappedNamespace: [false, true],
      wrappedNamed: [true, false],
      wrappedDefault: [true, false],
      wrappedNamespace: [false, true],
    });
  });

  it('should only replace free references to require', async () => {
    let b = await bundle(
      path.join(__dirname, 'integration/js-require-free/index.js'),
    );
    let output;
    await run(b, {
      output(v) {
        output = v;
      },
    });
    assert.strictEqual(output, 'a');
  });

  it('should only replace free references to require with scope hoisting', async () => {
    let b = await bundle(
      path.join(__dirname, 'integration/js-require-free/index.js'),
      {
        mode: 'production',
      },
    );
    let output;
    await run(b, {
      output(v) {
        output = v;
      },
    });
    assert.strictEqual(output, 'a');
  });

  it('should support import and non-top-level require of same asset from different assets', async () => {
    let b = await bundle(
      path.join(__dirname, 'integration/js-require-import-different/index.js'),
    );
    let {output} = await run(b, null, {require: false});
    assert.deepEqual(output, [123, {HooksContext: 123}]);
  });

  it('should support import and non-top-level require of same asset from different assets with scope hoisting', async () => {
    let b = await bundle(
      path.join(__dirname, 'integration/js-require-import-different/index.js'),
      {
        mode: 'production',
      },
    );
    let {output} = await run(b, null, {require: false});
    assert.deepEqual(output, [123, {HooksContext: 123}]);
  });

  it('should support runtime module deduplication', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-runtime-dedup/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        assets: ['async1.js', 'shared.js', 'esmodule-helpers.js'],
      },
      {
        assets: ['async2.js', 'shared.js', 'esmodule-helpers.js'],
      },
    ]);

    let res = await run(b);
    assert.equal(await res, true);
  });

  it('should support runtime module deduplication with scope hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-runtime-dedup/index.js'),
      {
        mode: 'production',
      },
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['async1.js', 'shared.js'],
      },
      {
        assets: ['async2.js', 'shared.js'],
      },
    ]);

    let res = await run(b);
    assert.equal(await res, true);
  });

  it('should remap locations in diagnostics using the input source map', async () => {
    let fixture = path.join(
      __dirname,
      'integration/diagnostic-sourcemap/index.js',
    );
    let code = await inputFS.readFileSync(fixture, 'utf8');
    await assert.rejects(
      () =>
        bundle(fixture, {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: "Failed to resolve 'foo' from './index.js'",
            origin: '@parcel/core',
            codeFrames: [
              {
                filePath: fixture,
                code,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 11,
                      column: 17,
                    },
                    end: {
                      line: 11,
                      column: 21,
                    },
                  },
                ],
              },
            ],
          },
          {
            message: "Cannot find module 'foo'",
            origin: '@parcel/resolver-default',
            hints: [],
          },
        ],
      },
    );
  });

  it('should reuse a bundle when its main asset (aka bundleroot) is imported sychronously', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/shared-bundle-single-source/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'css-loader.js',
          'esmodule-helpers.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['bar.js'],
      },
      {
        assets: ['a.js', 'b.js', 'foo.js'],
      },
      {
        assets: ['styles.css'],
      },
      {
        assets: ['local.html'],
      },
    ]);
  });

  it('should error on undeclared external dependencies for libraries', async function () {
    let fixture = path.join(
      __dirname,
      'integration/undeclared-external/index.js',
    );
    let pkg = path.join(
      __dirname,
      'integration/undeclared-external/package.json',
    );
    await assert.rejects(
      () =>
        bundle(fixture, {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: "Failed to resolve 'lodash' from './index.js'",
            origin: '@parcel/core',
            codeFrames: [
              {
                code: await inputFS.readFile(fixture, 'utf8'),
                filePath: fixture,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 19,
                    },
                    end: {
                      line: 1,
                      column: 26,
                    },
                  },
                ],
              },
            ],
          },
          {
            message:
              'External dependency "lodash" is not declared in package.json.',
            origin: '@parcel/resolver-default',
            codeFrames: [
              {
                code: await inputFS.readFile(pkg, 'utf8'),
                filePath: pkg,
                language: 'json',
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 5,
                      column: 3,
                    },
                    end: {
                      line: 5,
                      column: 16,
                    },
                  },
                ],
              },
            ],
            hints: ['Add "lodash" as a dependency.'],
          },
        ],
      },
    );
  });

  it('should error on undeclared helpers dependency for libraries', async function () {
    let fixture = path.join(
      __dirname,
      'integration/undeclared-external/helpers.js',
    );
    let pkg = path.join(
      __dirname,
      'integration/undeclared-external/package.json',
    );
    await assert.rejects(
      () =>
        bundle(fixture, {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: md`Failed to resolve '${'@swc/helpers/cjs/_class_call_check.cjs'}' from '${normalizePath(
              require.resolve('@parcel/transformer-js/src/JSTransformer.js'),
            )}'`,
            origin: '@parcel/core',
            codeFrames: [
              {
                code: await inputFS.readFile(fixture, 'utf8'),
                filePath: fixture,
                codeHighlights: [
                  {
                    message: undefined,
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
          },
          {
            message:
              'External dependency "@swc/helpers" is not declared in package.json.',
            origin: '@parcel/resolver-default',
            codeFrames: [
              {
                code: await inputFS.readFile(pkg, 'utf8'),
                filePath: pkg,
                language: 'json',
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 5,
                      column: 3,
                    },
                    end: {
                      line: 5,
                      column: 16,
                    },
                  },
                ],
              },
            ],
            hints: ['Add "@swc/helpers" as a dependency.'],
          },
        ],
      },
    );
  });

  it('should error on mismatched helpers version for libraries', async function () {
    let fixture = path.join(
      __dirname,
      'integration/undeclared-external/helpers.js',
    );
    let pkg = path.join(
      __dirname,
      'integration/undeclared-external/package.json',
    );
    let pkgContents = JSON.stringify(
      {
        ...JSON.parse(await overlayFS.readFile(pkg, 'utf8')),
        dependencies: {
          '@swc/helpers': '^0.3.0',
        },
      },
      false,
      2,
    );
    await overlayFS.mkdirp(path.dirname(pkg));
    await overlayFS.writeFile(pkg, pkgContents);
    await assert.rejects(
      () =>
        bundle(fixture, {
          mode: 'production',
          inputFS: overlayFS,
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: md`Failed to resolve '${'@swc/helpers/cjs/_class_call_check.cjs'}' from '${normalizePath(
              require.resolve('@parcel/transformer-js/src/JSTransformer.js'),
            )}'`,
            origin: '@parcel/core',
            codeFrames: [
              {
                code: await inputFS.readFile(fixture, 'utf8'),
                filePath: fixture,
                codeHighlights: [
                  {
                    message: undefined,
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
          },
          {
            message:
              'External dependency "@swc/helpers" does not satisfy required semver range "^0.5.0".',
            origin: '@parcel/resolver-default',
            codeFrames: [
              {
                code: pkgContents,
                filePath: pkg,
                language: 'json',
                codeHighlights: [
                  {
                    message: 'Found this conflicting requirement.',
                    start: {
                      line: 6,
                      column: 21,
                    },
                    end: {
                      line: 6,
                      column: 28,
                    },
                  },
                ],
              },
            ],
            hints: [
              'Update the dependency on "@swc/helpers" to satisfy "^0.5.0".',
            ],
          },
        ],
      },
    );
  });

  describe('multiple import types', function () {
    it('supports both static and dynamic imports to the same specifier in the same file', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/static-dynamic.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['static-dynamic.js', 'other.js', 'esmodule-helpers.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.Foo, 'function');
      assert.equal(typeof res.LazyFoo, 'object');
      assert.equal(res.Foo, await res.LazyFoo);
    });

    it('supports both static and dynamic imports to the same specifier in the same file with scope hoisting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/static-dynamic.js',
        ),
        {
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            isLibrary: true,
            shouldScopeHoist: true,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['static-dynamic.js', 'other.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.Foo, 'function');
      assert.equal(typeof res.LazyFoo, 'object');
      assert.equal(res.Foo, await res.LazyFoo);
    });

    it('supports static, dynamic, and url to the same specifier in the same file', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/static-dynamic-url.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: [
            'static-dynamic-url.js',
            'other.js',
            'esmodule-helpers.js',
            'bundle-url.js',
            'cacheLoader.js',
            'js-loader.js',
          ],
        },
        {
          type: 'js',
          assets: ['other.js', 'esmodule-helpers.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.Foo, 'function');
      assert.equal(typeof res.LazyFoo, 'object');
      assert.equal(res.Foo, await res.LazyFoo);
      assert.equal(
        res.url,
        'http://localhost/' + path.basename(b.getBundles()[1].filePath),
      );
    });

    it('supports static, dynamic, and url to the same specifier in the same file with scope hoisting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/static-dynamic-url.js',
        ),
        {
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            isLibrary: true,
            shouldScopeHoist: true,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['static-dynamic-url.js', 'other.js'],
        },
        {
          type: 'js',
          assets: ['other.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.Foo, 'function');
      assert.equal(typeof res.LazyFoo, 'object');
      assert.equal(res.Foo, await res.LazyFoo);
      assert.equal(
        res.url,
        'http://localhost/' + path.basename(b.getBundles()[1].filePath),
      );
    });

    it('supports dynamic import and url to the same specifier in the same file', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/dynamic-url.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: [
            'dynamic-url.js',
            'esmodule-helpers.js',
            'bundle-url.js',
            'cacheLoader.js',
            'js-loader.js',
          ],
        },
        {
          type: 'js',
          assets: ['other.js', 'esmodule-helpers.js'],
        },
      ]);
      let res = await run(b);
      assert.equal(typeof res.lazy, 'object');
      assert.equal(typeof (await res.lazy), 'function');
      assert.equal(
        res.url,
        'http://localhost/' + path.basename(b.getBundles()[1].filePath),
      );
    });

    it('supports dynamic import and url to the same specifier in the same file with scope hoisting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/dynamic-url.js',
        ),
        {
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            isLibrary: true,
            shouldScopeHoist: true,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['dynamic-url.js'],
        },
        {
          type: 'js',
          assets: ['other.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.lazy, 'object');
      assert.equal(typeof (await res.lazy), 'function');
      assert.equal(
        res.url,
        'http://localhost/' + path.basename(b.getBundles()[1].filePath),
      );
    });

    it('supports static import and inline bundle for the same asset', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/static-inline.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['static-inline.js', 'other.js', 'esmodule-helpers.js'],
        },
        {
          type: 'js',
          assets: ['other.js', 'esmodule-helpers.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.Foo, 'function');
      assert.equal(typeof res.text, 'string');
    });

    it('supports static import and inline bundle for the same asset with scope hoisting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/static-inline.js',
        ),
        {
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            isLibrary: true,
            shouldScopeHoist: true,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['static-inline.js', 'other.js'],
        },
        {
          type: 'js',
          assets: ['other.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.Foo, 'function');
      assert.equal(typeof res.text, 'string');
    });

    it('supports dynamic import and inline bundle for the same asset', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/dynamic-inline.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: [
            'dynamic-inline.js',
            'esmodule-helpers.js',
            'bundle-url.js',
            'cacheLoader.js',
            'js-loader.js',
          ],
        },
        {
          type: 'js',
          assets: ['other.js'],
        },
        {
          type: 'js',
          assets: ['other.js', 'esmodule-helpers.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.lazy, 'object');
      assert.equal(typeof (await res.lazy), 'function');
      assert.equal(typeof res.text, 'string');
    });

    it('supports dynamic import and inline bundle for the same asset with scope hoisting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/multiple-import-types/dynamic-inline.js',
        ),
        {
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            isLibrary: true,
            shouldScopeHoist: true,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['dynamic-inline.js'],
        },
        {
          type: 'js',
          assets: ['other.js'],
        },
        {
          type: 'js',
          assets: ['other.js'],
        },
      ]);

      let res = await run(b);
      assert.equal(typeof res.lazy, 'object');
      assert.equal(typeof (await res.lazy), 'function');
      assert.equal(typeof res.text, 'string');
    });
  });

  it('should avoid creating a bundle for lazy dependencies already available in a shared bundle', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/shared-bundle-internalization/index.mjs',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
      },
    );

    assert.deepEqual(await (await run(b)).default, [42, 42]);
  });

  it('should support standalone import.meta', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/import-meta/index.js'),
    );
    let res = await run(b);
    assert.deepEqual(res.default, {
      meta: {url: 'file:///integration/import-meta/index.js'},
      url: 'file:///integration/import-meta/index.js',
      equal: true,
    });

    assert.equal(Object.getPrototypeOf(res.default.meta), null);
    assert.equal(Object.isExtensible(res.default.meta), true);
    assert.deepEqual(Object.getOwnPropertyDescriptors(res.default.meta), {
      url: {
        writable: true,
        configurable: true,
        enumerable: true,
        value: 'file:///integration/import-meta/index.js',
      },
    });
  });

  it('should support importing async bundles from bundles with different dist paths', async function () {
    let bundleGraph = await bundle(
      ['bar/entry/entry-a.js', 'foo/entry-b.js'].map(f =>
        path.join(__dirname, 'integration/differing-bundle-urls', f),
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
        },
      },
    );
    assertBundles(bundleGraph, [
      {
        name: 'entry-a.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'entry-a.js',
          'js-loader.js',
        ],
      },
      {
        name: 'entry-b.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'entry-b.js',
          'js-loader.js',
        ],
      },
      {name: /deep\.[a-f0-9]+\.js/, assets: ['deep.js']},
      {name: /common\.[a-f0-9]+\.js/, assets: ['index.js']},
    ]);

    let [a, b] = bundleGraph.getBundles().filter(b => b.needsStableName);
    let calls = [];

    let bundles = [
      [await outputFS.readFile(a.filePath, 'utf8'), a],
      [await outputFS.readFile(b.filePath, 'utf8'), b],
    ];

    await runBundles(bundleGraph, a, bundles, {
      sideEffect: v => {
        calls.push(v);
      },
    });

    assert.deepEqual(calls, ['common', 'deep']);
  });

  it('supports deferring unused ESM imports with sideEffects: false', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/side-effects-false/import.js'),
    );

    let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');

    assert(!content.includes('returned from bar'));

    let called = false;
    let output = await run(b, {
      sideEffect() {
        called = true;
      },
    });

    assert(!called, 'side effect called');
    assert.strictEqual(output.default, 4);
  });

  it('supports ESM imports and requires with sideEffects: false', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/side-effects-false/import-require.js'),
    );

    let output = await run(b, {
      sideEffect() {},
    });

    assert.strictEqual(output.default, '4returned from bar');
  });

  it('should not affect ESM import order', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/js-import-initialization/a.mjs'),
    );

    await assert.rejects(
      run(b),
      new ReferenceError("Cannot access 'foo' before initialization"),
    );
  });

  it('should not affect ESM import order with scope hoisting', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/js-import-initialization/a.mjs'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    await assert.rejects(
      run(b),
      /^ReferenceError: Cannot access '(.+)' before initialization$/,
    );
  });

  it('should produce working output with both scope hoisting and non scope hoisting targets', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/re-export-no-scope-hoist'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );
    let bundles = b.getBundles();

    let o1, o2;
    await runBundle(b, bundles[0], {
      output: (...o) => (o1 = o),
    });

    await runBundle(b, bundles[1], {
      output: (...o) => (o2 = o),
    });

    assert.deepEqual(o1, ['UIIcon', 'Icon']);
    assert.deepEqual(o2, ['UIIcon', 'Icon']);
  });

  it('should not deduplicate an asset if it will become unreachable', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/sibling-deduplicate-unreachable/index.js',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
      },
    );
    let res = await run(b);
    assert.equal(await res.default, 'target');
  });

  it('should detect shorthand identifier imports', async function () {
    const dir = path.join(__dirname, 'js-import-shorthand-identifier');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      package.json:
        {
          "name": "app",
          "private": true,
          "sideEffects": false
        }

      index.js:
        import { tokens, mode } from "./tokens.js";

        export default tokens;

      tokens.js:
        import { color } from "./color.js";

        export const tokens = {
          color,
        };

        export { mode } from "./color.js";

      color.js:
        export const color = "blue";
        export const mode = "dark";`;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
    });

    let output = await run(b);
    assert.deepEqual(output.default, {color: 'blue'});
  });

  it('should retain unicode escape sequences', async function () {
    // See issue #8877
    await fsFixture(overlayFS, __dirname)`
        src/index.js:
          export default ['\\u0085', '\\u200b', '\\ufffe'];
      `;

    let b = await bundle(path.join(__dirname, 'src/index.js'), {
      inputFS: overlayFS,
    });

    let output = (await run(b)).default;
    assert.deepEqual(output, ['\u0085', '\u200b', '\ufffe']);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert.equal(contents.match(/\\/g).length, 3);
    assert(!contents.includes('\u0085'));
    assert(!contents.includes('\u200b'));
    assert(!contents.includes('\ufffe'));
  });

  it(`should not wrap assets that are duplicated in different targets`, async function () {
    const dir = path.join(__dirname, 'multi-target-duplicates');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      shared/index.js:
        export default 2;

      packages/a/package.json:
        {
          "source": "index.js",
          "module": "dist/module.js"
        }

      packages/a/index.js:
        import shared from '../../shared';
        export default shared + 2;

      packages/b/package.json:
        {
          "source": "index.js",
          "module": "dist/module.js"
        }

      packages/b/index.js:
        import shared from '../../shared';
        export default shared + 2;
    `;

    let b = await bundle(path.join(dir, '/packages/*'), {
      inputFS: overlayFS,
    });

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(
        !contents.includes('parcelRequire'),
        'should not include parcelRequire',
      );
    }
  });

  it(`should not wrap assets that are duplicated in different targets in the same dist dir`, async function () {
    const dir = path.join(__dirname, 'multi-target-duplicates-dist');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      package.json:
        {
          "main": "dist/main.cjs",
          "browser": "dist/browser.cjs",
          "targets": {
            "main": {
              "source": "node.js",
              "context": "browser",
              "engines": {
                "browsers": "chrome >= 70"
              }
            },
            "browser": {
              "source": "browser.js",
              "engines": {
                "browsers": "chrome >= 70"
              }
            }
          }
        }

      node.js:
        import shared from './shared';
        export default shared + 2;

      browser.js:
        import shared from './shared';
        export default shared + 2;

      shared.js:
        export default 2;
    `;

    let b = await bundle(dir, {
      inputFS: overlayFS,
    });

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(
        !contents.includes('parcelRequire'),
        'should not include parcelRequire',
      );
    }
  });

  it(`should also fail on recoverable parse errors`, async () => {
    await fsFixture(overlayFS, __dirname)`
      js-recoverable-parse-errors
        index.js:
          1 / {2}`;

    const fixture = path.join(
      __dirname,
      '/js-recoverable-parse-errors/index.js',
    );

    await assert.rejects(
      () =>
        bundle(fixture, {
          inputFS: overlayFS,
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            origin: '@parcel/transformer-js',
            message: 'Unexpected token `}`. Expected identifier',
            hints: null,
            codeFrames: [
              {
                filePath: fixture,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      column: 7,
                      line: 1,
                    },
                    end: {
                      column: 7,
                      line: 1,
                    },
                  },
                ],
              },
            ],
          },
        ],
      },
    );
  });

  for (let shouldScopeHoist of [false, true]) {
    let options = {
      defaultTargetOptions: {
        shouldScopeHoist,
      },
      mode: 'production',
    };
    let usesSymbolPropagation = shouldScopeHoist;
    describe(`sideEffects: false with${
      shouldScopeHoist ? '' : 'out'
    } scope-hoisting`, function () {
      if (usesSymbolPropagation) {
        it('supports excluding unused CSS imports', async function () {
          let b = await bundle(
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/side-effects-css/index.html',
            ),
            options,
          );

          assertBundles(b, [
            {
              name: 'index.html',
              assets: ['index.html'],
            },
            {
              type: 'js',
              assets: ['index.js', 'b1.js'],
            },
            {
              type: 'css',
              assets: ['b1.css'],
            },
          ]);

          let calls = [];
          let res = await run(
            b,
            {
              output: null,
              sideEffect: caller => {
                calls.push(caller);
              },
            },
            {require: false},
          );
          assert.deepEqual(calls, ['b1']);
          assert.deepEqual(res.output, 2);

          let css = await outputFS.readFile(
            b.getBundles().find(bundle => bundle.type === 'css').filePath,
            'utf8',
          );
          assert(!css.includes('.b2'));
        });

        it("doesn't create new bundles for dynamic imports in excluded assets", async function () {
          let b = await bundle(
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/side-effects-no-new-bundle/index.html',
            ),
            options,
          );

          assertBundles(b, [
            {
              name: 'index.html',
              assets: ['index.html'],
            },
            {
              type: 'js',
              assets: ['index.js', 'b1.js'],
            },
          ]);

          let calls = [];
          let res = await run(
            b,
            {
              output: null,
              sideEffect: caller => {
                calls.push(caller);
              },
            },
            {require: false},
          );
          assert.deepEqual(calls, ['b1']);
          assert.deepEqual(res.output, 2);
        });
      }

      it('supports deferring unused ES6 re-exports (namespace used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports/a.js',
          ),
          options,
        );

        assertBundles(b, [
          {
            type: 'js',
            assets: usesSymbolPropagation
              ? ['a.js', 'message1.js']
              : ['a.js', 'esmodule-helpers.js', 'index.js', 'message1.js'],
          },
        ]);

        if (usesSymbolPropagation) {
          // TODO this only excluded, but should be deferred.
          assert(!findAsset(b, 'message3.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['message1'] : ['message1', 'index'],
        );
        assert.deepEqual(res.output, 'Message 1');
      });

      it('supports deferring an unused ES6 re-export (wildcard, empty, unused)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-all-empty/a.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assertDependencyWasExcluded(b, 'index.js', './empty.js');
        }

        assert.deepEqual((await run(b, null, {require: false})).output, 123);
      });

      it('supports deferring unused ES6 re-exports (reexport named used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports/b.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'message1.js'));
          assert(!findAsset(b, 'message3.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['message2'] : ['message2', 'index'],
        );
        assert.deepEqual(res.output, 'Message 2');
      });

      it('supports deferring unused ES6 re-exports (namespace rename used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports/c.js',
          ),
          options,
        );

        assertBundles(b, [
          {
            type: 'js',
            assets: usesSymbolPropagation
              ? ['c.js', 'message3.js']
              : ['c.js', 'esmodule-helpers.js', 'index.js', 'message3.js'],
          },
        ]);

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'message1.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['message3'] : ['message3', 'index'],
        );
        assert.deepEqual(res.output, {default: 'Message 3'});
      });

      it('supports deferring unused ES6 re-exports (direct export used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports/d.js',
          ),
          options,
        );

        assertDependencyWasExcluded(b, 'index.js', './message2.js');
        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'message1.js'));
          assert(!findAsset(b, 'message3.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(calls, ['index']);
        assert.deepEqual(res.output, 'Message 4');
      });

      it('supports chained ES6 re-exports', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-chained/index.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'bar.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        if (shouldScopeHoist) {
          try {
            assert.deepEqual(calls, ['key', 'foo', 'index']);
          } catch (e) {
            // A different dependency order, but this is deemed acceptable as it's sideeffect free
            assert.deepEqual(calls, ['foo', 'key', 'index']);
          }
        } else {
          assert.deepEqual(calls, ['key', 'foo', 'types', 'index']);
        }

        assert.deepEqual(res.output, ['key', 'foo']);
      });

      it('should not optimize away an unused ES6 re-export and an used import', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-import/a.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(res.output, 123);
      });

      it('should not optimize away an unused ES6 re-export and an used import (different symbols)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-import-different/a.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(res.output, 123);
      });

      it('correctly handles ES6 re-exports in library mode entries', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-library/a.js',
          ),
          options,
        );

        let contents = await outputFS.readFile(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-library/build.js',
          ),
          'utf8',
        );
        assert(!contents.includes('console.log'));

        let res = await run(b);
        assert.deepEqual(res, {c1: 'foo'});
      });

      if (shouldScopeHoist) {
        it('correctly updates deferred assets that are reexported', async function () {
          let testDir = path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-update-deferred-reexported',
          );

          let b = bundler(path.join(testDir, 'index.js'), {
            inputFS: overlayFS,
            outputFS: overlayFS,
            ...options,
          });

          let subscription = await b.watch();

          let bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, '12345hello');

          await overlayFS.mkdirp(path.join(testDir, 'node_modules', 'foo'));
          await overlayFS.copyFile(
            path.join(testDir, 'node_modules', 'foo', 'foo_updated.js'),
            path.join(testDir, 'node_modules', 'foo', 'foo.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, '1234556789');

          await subscription.unsubscribe();
        });

        it('correctly updates deferred assets that are reexported and imported directly', async function () {
          let testDir = path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-update-deferred-direct',
          );

          let b = bundler(path.join(testDir, 'index.js'), {
            inputFS: overlayFS,
            outputFS: overlayFS,
            ...options,
          });

          let subscription = await b.watch();

          let bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, '12345hello');

          await overlayFS.mkdirp(path.join(testDir, 'node_modules', 'foo'));
          await overlayFS.copyFile(
            path.join(testDir, 'node_modules', 'foo', 'foo_updated.js'),
            path.join(testDir, 'node_modules', 'foo', 'foo.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, '1234556789');

          await subscription.unsubscribe();
        });

        it('removes deferred reexports when imported from multiple asssets', async function () {
          let b = await bundle(
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/side-effects-re-exports-multiple-dynamic/a.js',
            ),
            options,
          );

          let contents = await outputFS.readFile(
            b.getBundles()[0].filePath,
            'utf8',
          );

          assert(!contents.includes('$import$'));
          assert(/=\s*1234/.test(contents));
          assert(!/=\s*5678/.test(contents));

          let output = await run(b);
          assert.deepEqual(output, [1234, {default: 1234}]);
        });
      }

      it('keeps side effects by default', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects/a.js',
          ),
          options,
        );

        let called = false;
        let res = await run(
          b,
          {
            sideEffect: () => {
              called = true;
            },
          },
          {require: false},
        );

        assert(called, 'side effect not called');
        assert.deepEqual(res.output, 4);
      });

      it('supports the package.json sideEffects: false flag', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-false/a.js',
          ),
          options,
        );

        let called = false;
        let res = await run(
          b,
          {
            sideEffect: () => {
              called = true;
            },
          },
          {require: false},
        );

        assert(!called, 'side effect called');
        assert.deepEqual(res.output, 4);
      });

      it('supports removing a deferred dependency', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/side-effects-false',
        );

        let b = bundler(path.join(testDir, 'a.js'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
          ...options,
        });

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          let called = false;
          let res = await run(
            bundleEvent.bundleGraph,
            {
              sideEffect: () => {
                called = true;
              },
            },
            {require: false},
          );
          assert(!called, 'side effect called');
          assert.deepEqual(res.output, 4);
          if (usesSymbolPropagation) {
            assert(!findAsset(bundleEvent.bundleGraph, 'index.js'));
          }

          await overlayFS.mkdirp(path.join(testDir, 'node_modules/bar'));
          await overlayFS.copyFile(
            path.join(testDir, 'node_modules/bar/index.1.js'),
            path.join(testDir, 'node_modules/bar/index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          called = false;
          res = await run(
            bundleEvent.bundleGraph,
            {
              sideEffect: () => {
                called = true;
              },
            },
            {require: false},
          );
          assert(!called, 'side effect called');
          assert.deepEqual(res.output, 4);
        } finally {
          await subscription.unsubscribe();
        }
      });

      it('supports wildcards', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-false-wildcards/a.js',
          ),
          options,
        );
        let called = false;
        let res = await run(
          b,
          {
            sideEffect: () => {
              called = true;
            },
          },
          {require: false},
        );

        if (usesSymbolPropagation) {
          assert(!called, 'side effect called');
        }
        assert.deepEqual(res.output, 'bar');
      });

      it('correctly handles excluded and wrapped reexport assets', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-false-wrap-excluded/a.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(res.output, 4);
      });

      it('supports the package.json sideEffects flag with an array', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-array/a.js',
          ),
          options,
        );

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert(calls.toString() == 'foo', "side effect called for 'foo'");
        assert.deepEqual(res.output, 4);
      });

      it('supports the package.json sideEffects: false flag with shared dependencies', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-false-duplicate/a.js',
          ),
          options,
        );

        let called = false;
        let res = await run(
          b,
          {
            sideEffect: () => {
              called = true;
            },
          },
          {require: false},
        );

        assert(!called, 'side effect called');
        assert.deepEqual(res.output, 6);
      });

      it('supports the package.json sideEffects: false flag with shared dependencies and code splitting', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-split/a.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(await res.output, 581);
      });

      it('supports the package.json sideEffects: false flag with shared dependencies and code splitting II', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-split2/a.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(await res.output, [{default: 123, foo: 2}, 581]);
      });

      it('missing exports should be replaced with an empty object', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/empty-module/a.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(res.output, {b: {}});
      });

      it('supports namespace imports of theoretically excluded reexporting assets', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/import-namespace-sideEffects/index.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(res.output, {Main: 'main', a: 'foo', b: 'bar'});
      });

      it('can import from a different bundle via a re-export', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/re-export-bundle-boundary-side-effects/index.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(await res.output, ['operational', 'ui']);
      });

      it('supports excluding multiple chained namespace reexports', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-chained-re-exports-multiple/a.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'symbol1.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['message1'] : ['message1', 'message'],
        );
        assert.deepEqual(res.output, 'Message 1');
      });

      it('supports excluding when doing both exports and reexports', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-export-reexport/a.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'other.js'));
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(calls, ['index']);
        assert.deepEqual(res.output, 'Message 1');
      });

      it('supports deferring with chained renaming reexports', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-rename-chained/a.js',
          ),
          options,
        );

        // assertDependencyWasExcluded(b, 'message.js', './message2');

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist
            ? ['message1']
            : ['message1', 'message', 'index2', 'index'],
        );
        assert.deepEqual(res.output, 'Message 1');
      });

      it('supports named and renamed reexports of the same asset (default used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-rename-same2/a.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'other.js')))),
            new Set(['bar']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['other'] : ['other', 'index'],
        );
        assert.deepEqual(res.output, 'bar');
      });

      it('supports named and renamed reexports of the same asset (named used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-rename-same2/b.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'other.js')))),
            new Set(['bar']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['other'] : ['other', 'index'],
        );
        assert.deepEqual(res.output, 'bar');
      });

      it('supports named and renamed reexports of the same asset (namespace used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-rename-same/index.js',
          ),
          options,
        );

        let res = await run(b, null, {require: false});
        assert.deepEqual(res.output, [{value1: 123, value2: 123}, 123, 123]);
      });

      it('supports reexports via variable declaration (unused)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-rename-var-unused/index.js',
          ),
          options,
        );

        let res = await run(b, {}, {require: false});
        assert.deepEqual((await res.output).foo, 'foo');
      });

      it('supports named and namespace exports of the same asset (named used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-namespace-same/a.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'index.js'));
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'other.js')))),
            new Set(['default']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['other'] : ['other', 'index'],
        );
        assert.deepEqual(res.output, ['foo']);
      });

      it('supports named and namespace exports of the same asset (namespace used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-namespace-same/b.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'index.js'));
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'other.js')))),
            new Set(['bar']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['other'] : ['other', 'index'],
        );
        assert.deepEqual(res.output, ['bar']);
      });

      it('supports named and namespace exports of the same asset (both used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-namespace-same/c.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'index.js'));
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'other.js')))),
            new Set(['default', 'bar']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['other'] : ['other', 'index'],
        );
        assert.deepEqual(res.output, ['foo', 'bar']);
      });

      it('supports partially used reexporting index file', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-re-exports-partially-used/index.js',
          ),
          options,
        );

        let calls = [];
        let res = (
          await run(
            b,
            {
              sideEffect: caller => {
                calls.push(caller);
              },
            },
            {require: false},
          )
        ).output;

        let [v, async] = res;

        assert.deepEqual(calls, shouldScopeHoist ? ['b'] : ['b', 'index']);
        assert.deepEqual(v, 2);

        v = await async();
        assert.deepEqual(
          calls,
          shouldScopeHoist
            ? ['b', 'a', 'index', 'dynamic']
            : ['b', 'index', 'a', 'dynamic'],
        );
        assert.deepEqual(v.default, [1, 3]);
      });

      it('supports deferring non-weak dependencies that are not used', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-semi-weak/a.js',
          ),
          options,
        );

        // assertDependencyWasExcluded(b, 'esm2.js', './other.js');

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['esm1'] : ['esm1', 'index'],
        );
        assert.deepEqual(res.output, 'Message 1');
      });

      it('supports excluding CommonJS (CommonJS unused)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-commonjs/a.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'esm.js')))),
            new Set(['message1']),
          );
          // We can't statically analyze commonjs.js, so message1 appears to be used
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'commonjs.js')))),
            // the exports object is used freely
            new Set(['*', 'message1']),
          );
          assert.deepStrictEqual(
            new Set(
              b.getUsedSymbols(findDependency(b, 'index.js', './commonjs.js')),
            ),
            new Set(['message1']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );

        assert.deepEqual(calls, ['esm', 'commonjs', 'index']);
        assert.deepEqual(res.output, 'Message 1');
      });

      it('supports excluding CommonJS (CommonJS used)', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-commonjs/b.js',
          ),
          options,
        );

        if (usesSymbolPropagation) {
          assert(!findAsset(b, 'esm.js'));
          assert(!findAsset(b, 'index.js'));
          assert.deepStrictEqual(
            new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'commonjs.js')))),
            // the exports object is used freely
            new Set(['*', 'message2']),
          );
        }

        let calls = [];
        let res = await run(
          b,
          {
            sideEffect: caller => {
              calls.push(caller);
            },
          },
          {require: false},
        );
        assert.deepEqual(
          calls,
          shouldScopeHoist ? ['commonjs'] : ['commonjs', 'index'],
        );
        assert.deepEqual(res.output, 'Message 2');
      });
    });

    it(`ignores missing unused import specifiers in source assets ${
      shouldScopeHoist ? 'with' : 'without'
    } scope-hoisting`, async function () {
      let b = await bundle(
        path.join(__dirname, 'integration/js-unused-import-specifier/a.js'),
        options,
      );
      let res = await run(b, null, {require: false});
      assert.equal(res.output, 123);
    });

    it(`ignores missing unused import specifiers in node-modules ${
      shouldScopeHoist ? 'with' : 'without'
    } scope-hoisting`, async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/js-unused-import-specifier-node-modules/a.js',
        ),
        options,
      );

      let res = await run(b, null, {require: false});
      assert.equal(res.output, 123);
    });

    it(`duplicate assets should share module scope  ${
      shouldScopeHoist ? 'with' : 'without'
    } scope-hoisting`, async function () {
      let b = await bundle(
        [
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/multi-entry-duplicates/one.js',
          ),
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/multi-entry-duplicates/two.js',
          ),
        ],
        options,
      );

      let result = await runBundle(b, b.getBundles()[0], {}, {require: false});

      assert.equal(await result.output, 2);
    });

    it(`should work correctly with export called hasOwnProperty ${
      shouldScopeHoist ? 'with' : 'without'
    } scope-hoisting`, async () => {
      await fsFixture(overlayFS, __dirname)`
        js-export-all-hasOwnProperty
          a.js:
            export function hasOwnProperty() {
              throw new Error("Shouldn't be called");
            }
          b.js:
            module.exports = { other: 123 }

          library.js:
            export * from './a';
            export * from './b';

          index.js:
            import * as x from './library';
            output = sideEffectNoop(x).other;`;

      let b = await bundle(
        path.join(__dirname, 'js-export-all-hasOwnProperty/index.js'),
        {
          ...options,
          inputFS: overlayFS,
        },
      );
      let res = await run(b, null, {require: false});
      assert.equal(res.output, 123);
    });
  }
});
