import assert from 'assert';
import nodeFS from 'fs';
import path from 'path';
import {
  assertBundles,
  bundler,
  getNextBuild,
  run,
  assertBundleTree,
  nextBundle,
  ncp,
  inputFS as fs,
  sleep,
  symlinkPrivilegeWarning,
  outputFS,
  overlayFS,
} from '@parcel/test-utils';
import {symlinkSync} from 'fs';

const inputDir = path.join(__dirname, '/watcher');
const distDir = path.join(inputDir, 'dist');

describe('watcher', function () {
  let subscription;
  afterEach(async () => {
    if (subscription) {
      await subscription.unsubscribe();
    }
    subscription = null;
  });

  it('should rebuild on source file change', async function () {
    await outputFS.mkdirp(inputDir);
    await outputFS.writeFile(
      path.join(inputDir, '/index.js'),
      'module.exports = "hello"',
      'utf8',
    );
    let b = bundler(path.join(inputDir, '/index.js'), {inputFS: overlayFS});
    subscription = await b.watch();
    let buildEvent = await getNextBuild(b);
    let output = await run(buildEvent.bundleGraph);
    assert.equal(output, 'hello');

    await outputFS.writeFile(
      path.join(inputDir, '/index.js'),
      'module.exports = "something else"',
      'utf8',
    );
    buildEvent = await getNextBuild(b);
    output = await run(buildEvent.bundleGraph);
    assert.equal(output, 'something else');
  });

  it('should rebuild on a source file change after a failed transformation', async () => {
    await outputFS.mkdirp(inputDir);
    await outputFS.writeFile(
      path.join(inputDir, '/index.js'),
      'syntax\\error',
      'utf8',
    );
    let b = bundler(path.join(inputDir, '/index.js'), {inputFS: overlayFS});
    subscription = await b.watch();
    let buildEvent = await getNextBuild(b);
    assert.equal(buildEvent.type, 'buildFailure');
    await outputFS.writeFile(
      path.join(inputDir, '/index.js'),
      'module.exports = "hello"',
      'utf8',
    );
    buildEvent = await getNextBuild(b);
    let output = await run(buildEvent.bundleGraph);

    assert.equal(output, 'hello');
  });

  it('should rebuild on a config file change', async function () {
    let inDir = path.join(__dirname, 'integration/parcelrc-custom');
    let outDir = path.join(inDir, 'dist');

    await ncp(path.join(__dirname, 'integration/parcelrc-custom'), inDir);
    await ncp(
      path.dirname(require.resolve('@parcel/config-default')),
      path.join(inDir, 'node_modules', '@parcel', 'config-default'),
    );
    let copyPath = path.join(inDir, 'configCopy');
    let configPath = path.join(inDir, '.parcelrc');
    let b = bundler(path.join(inDir, 'index.js'), {
      inputFS: overlayFS,
      targets: {
        main: {
          distDir: outDir,
        },
      },
    });
    subscription = await b.watch();
    await getNextBuild(b);
    let distFile = await outputFS.readFile(
      path.join(outDir, 'index.js'),
      'utf8',
    );
    assert(distFile.includes('() => null'));
    await outputFS.copyFile(copyPath, configPath);
    await getNextBuild(b);
    distFile = await outputFS.readFile(path.join(outDir, 'index.js'), 'utf8');
    assert(distFile.includes('TRANSFORMED CODE'));
  });

  it('should rebuild properly when a dependency is removed', async function () {
    await ncp(path.join(__dirname, 'integration/babel-default'), inputDir);

    let b = bundler(path.join(inputDir, 'index.js'), {
      inputFS: overlayFS,
      targets: {
        main: {
          engines: {
            node: '^8.0.0',
          },
          distDir,
        },
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);
    let distFile = await outputFS.readFile(
      path.join(distDir, 'index.js'),
      'utf8',
    );
    assert(distFile.includes('Foo'));
    await outputFS.writeFile(
      path.join(inputDir, 'index.js'),
      'console.log("no more dependencies")',
    );
    await getNextBuild(b);
    distFile = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(!distFile.includes('Foo'));
  });

  it.skip('should re-generate bundle tree when files change', async function () {
    await ncp(path.join(__dirname, '/integration/dynamic-hoist'), inputDir);

    let b = bundler(path.join(inputDir, '/index.js'), {watch: true});
    let bundle = await b.bundle();

    await assertBundleTree(bundle, {
      name: 'index.js',
      assets: [
        'index.js',
        'common.js',
        'common-dep.js',
        'bundle-loader.js',
        'js-loader.js',
      ],
      childBundles: [
        {
          assets: ['a.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          assets: ['b.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          type: 'map',
        },
      ],
    });

    let output = await run(bundle);
    assert.equal(await output(), 7);

    // change b.js so that it no longer depends on common.js.
    // This should cause common.js and dependencies to no longer be hoisted to the root bundle.
    await sleep(100);
    fs.writeFile(path.join(inputDir, '/b.js'), 'module.exports = 5;');

    bundle = await nextBundle(b);
    await assertBundleTree(bundle, {
      name: 'index.js',
      assets: ['index.js', 'bundle-loader.js', 'js-loader.js'],
      childBundles: [
        {
          assets: ['a.js', 'common.js', 'common-dep.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          assets: ['b.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          type: 'map',
        },
      ],
    });

    output = await run(bundle);
    assert.equal(await output(), 8);
  });

  it.skip('should only re-package bundles that changed', async function () {
    await ncp(path.join(__dirname, '/integration/dynamic-hoist'), inputDir);
    let b = bundler(path.join(inputDir, '/index.js'), {watch: true});

    await b.bundle();
    let mtimes = (await fs.readdir(path.join(__dirname, '/dist'))).map(
      f =>
        (nodeFS.statSync(path.join(__dirname, '/dist/', f)).mtime.getTime() /
          1000) |
        0,
    );

    await sleep(1100); // mtime only has second level precision
    fs.writeFile(
      path.join(inputDir, '/b.js'),
      'module.exports = require("./common")',
    );

    await nextBundle(b);
    let newMtimes = (await fs.readdir(path.join(__dirname, '/dist'))).map(
      f =>
        (nodeFS.statSync(path.join(__dirname, '/dist/', f)).mtime.getTime() /
          1000) |
        0,
    );
    assert.deepEqual(mtimes.sort().slice(0, 2), newMtimes.sort().slice(0, 2));
    assert.notEqual(mtimes[mtimes.length - 1], newMtimes[newMtimes.length - 1]);
  });

  it.skip('should unload assets that are orphaned', async function () {
    await ncp(path.join(__dirname, '/integration/dynamic-hoist'), inputDir);
    let b = bundler(path.join(inputDir, '/index.js'), {watch: true});

    let bundle = await b.bundle();
    await assertBundleTree(bundle, {
      name: 'index.js',
      assets: [
        'index.js',
        'common.js',
        'common-dep.js',
        'bundle-loader.js',
        'js-loader.js',
      ],
      childBundles: [
        {
          assets: ['a.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          assets: ['b.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          type: 'map',
        },
      ],
    });

    let output = await run(bundle);
    assert.equal(await output(), 7);

    assert(b.loadedAssets.has(path.join(inputDir, '/common-dep.js')));

    // Get rid of common-dep.js
    await sleep(100);
    fs.writeFile(path.join(inputDir, '/common.js'), 'module.exports = 5;');

    bundle = await nextBundle(b);
    await assertBundleTree(bundle, {
      name: 'index.js',
      assets: ['index.js', 'common.js', 'bundle-loader.js', 'js-loader.js'],
      childBundles: [
        {
          assets: ['a.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          assets: ['b.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
        {
          type: 'map',
        },
      ],
    });

    output = await run(bundle);
    assert.equal(await output(), 13);

    assert(!b.loadedAssets.has(path.join(inputDir, 'common-dep.js')));
  });

  it.skip('should recompile all assets when a config file changes', async function () {
    await ncp(path.join(__dirname, '/integration/babel'), inputDir);
    let b = bundler(path.join(inputDir, 'index.js'), {watch: true});

    await b.bundle();
    let file = await fs.readFile(
      path.join(__dirname, '/dist/index.js'),
      'utf8',
    );
    assert(!file.includes('function Foo'));
    assert(!file.includes('function Bar'));

    // Change babelrc, should recompile both files
    let babelrc = JSON.parse(
      await fs.readFile(path.join(inputDir, '/.babelrc'), 'utf8'),
    );
    babelrc.presets[0][1].targets.browsers.push('IE >= 11');

    await sleep(100);
    fs.writeFile(path.join(inputDir, '/.babelrc'), JSON.stringify(babelrc));

    await nextBundle(b);
    file = await fs.readFile(path.join(__dirname, '/dist/index.js'), 'utf8');
    assert(file.includes('function Foo'));
    assert(file.includes('function Bar'));
  });

  it.skip('should rebuild if the file behind a symlink changes', async function () {
    await ncp(
      path.join(__dirname, '/integration/commonjs-with-symlinks/'),
      inputDir,
    );

    try {
      // Create the symlink here to prevent cross platform and git issues
      symlinkSync(
        path.join(inputDir, 'local.js'),
        path.join(inputDir, 'src/symlinked_local.js'),
      );

      let b = bundler(path.join(inputDir, '/src/index.js'), {
        watch: true,
      });

      let bundle = await b.bundle();
      let output = await run(bundle);

      assert.equal(output(), 3);

      await sleep(100);
      fs.writeFile(
        path.join(inputDir, '/local.js'),
        'exports.a = 5; exports.b = 5;',
      );

      bundle = await nextBundle(b);
      output = await run(bundle);
      assert.equal(output(), 10);
    } catch (e) {
      if (e.code == 'EPERM') {
        symlinkPrivilegeWarning();
        this.skip();
      } else {
        throw e;
      }
    }
  });

  it('should add and remove necessary runtimes to bundles', async () => {
    await ncp(path.join(__dirname, 'integration/dynamic'), inputDir);

    let indexPath = path.join(inputDir, 'index.js');

    let b = bundler(indexPath, {inputFS: overlayFS});
    let bundleGraph;
    subscription = await b.watch((err, event) => {
      assert(event.type === 'buildSuccess');
      bundleGraph = event.bundleGraph;
    });
    await getNextBuild(b);
    assertBundles(bundleGraph, [
      {
        name: 'index.js',
        assets: ['index.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {assets: ['local.js']},
    ]);

    await outputFS.writeFile(path.join(inputDir, 'other.js'), '');
    await outputFS.writeFile(
      indexPath,
      (await outputFS.readFile(indexPath, 'utf8')) +
        "\nimport('./other.js');\n",
    );

    await getNextBuild(b);
    assertBundles(bundleGraph, [
      {
        name: 'index.js',
        assets: ['index.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {assets: ['local.js']},
      {assets: ['other.js']},
    ]);

    await outputFS.writeFile(indexPath, '');

    await getNextBuild(b);
    assertBundles(bundleGraph, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
    ]);
  });

  it('should rebuild if a missing file is added', async function () {
    await outputFS.mkdirp(inputDir);
    await outputFS.writeFile(
      path.join(inputDir, '/index.js'),
      'import {other} from "./other";\nexport default other;',
      'utf8',
    );

    let b = bundler(path.join(inputDir, 'index.js'), {inputFS: overlayFS});
    subscription = await b.watch();
    let buildEvent = await getNextBuild(b);
    assert.equal(buildEvent.type, 'buildFailure');

    await outputFS.writeFile(
      path.join(inputDir, '/other.js'),
      'export const other = 2;',
      'utf8',
    );

    buildEvent = await getNextBuild(b);
    assert.equal(buildEvent.type, 'buildSuccess');

    let res = await run(buildEvent.bundleGraph);
    assert.equal(res.default, 2);
  });
});
