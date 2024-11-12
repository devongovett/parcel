// @flow
import type {InitialParcelOptions, BuildSuccessEvent} from '@parcel/types';
import assert from 'assert';
import invariant from 'assert';
import nullthrows from 'nullthrows';
import path from 'path';
import {
  assertBundles,
  bundler,
  run,
  runBundle as runSingleBundle,
  overlayFS,
  outputFS,
  inputFS,
  ncp,
  workerFarm,
  mergeParcelOptions,
  sleep,
  getNextBuild,
  distDir,
  getParcelOptions,
  assertNoFilePathInCache,
  findAsset,
  bundle,
  fsFixture,
} from '@parcel/test-utils';
import {md} from '@parcel/diagnostic';
import fs from 'fs';
import {NodePackageManager} from '@parcel/package-manager';
import {createWorkerFarm} from '@parcel/core';
import resolveOptions from '@parcel/core/src/resolveOptions';
import logger from '@parcel/logger';
import sinon from 'sinon';
import {version} from '@parcel/core/package.json';
import {deserialize} from '@parcel/core/src/serializer';
import {hashString} from '@parcel/rust';

let inputDir: string;
let packageManager = new NodePackageManager(inputFS, '/');

function getEntries(entries = 'src/index.js') {
  return (Array.isArray(entries) ? entries : [entries]).map(entry =>
    path.resolve(inputDir, entry),
  );
}

function getOptions(opts) {
  return mergeParcelOptions(
    {
      inputFS: overlayFS,
      shouldDisableCache: false,
    },
    opts,
  );
}

function runBundle(entries = 'src/index.js', opts) {
  return bundler(getEntries(entries), getOptions(opts)).run();
}

type UpdateFn = BuildSuccessEvent =>
  | ?InitialParcelOptions
  | Promise<?InitialParcelOptions>;
type TestConfig = {|
  ...InitialParcelOptions,
  entries?: Array<string>,
  setup?: () => void | Promise<void>,
  update: UpdateFn,
|};

async function testCache(update: UpdateFn | TestConfig, integration) {
  await overlayFS.rimraf(path.join(__dirname, '/input'));
  await ncp(
    path.join(__dirname, '/integration', integration ?? 'cache'),
    path.join(inputDir),
  );

  let entries;
  let options: ?InitialParcelOptions;
  if (typeof update === 'object') {
    let setup;
    ({entries, setup, update, ...options} = update);

    if (setup) {
      await setup();
    }
  }

  let resolvedOptions = await resolveOptions(
    getParcelOptions(getEntries(entries), getOptions(options)),
  );

  let b = await runBundle(entries, options);

  await assertNoFilePathInCache(
    resolvedOptions.outputFS,
    resolvedOptions.cacheDir,
    resolvedOptions.projectRoot,
  );

  // update
  let newOptions = await update(b);
  options = mergeParcelOptions(options || {}, newOptions);

  // Run cached build
  b = await runBundle(entries, options);

  resolvedOptions = await resolveOptions(
    getParcelOptions(getEntries(entries), getOptions(options)),
  );
  await assertNoFilePathInCache(
    resolvedOptions.outputFS,
    resolvedOptions.cacheDir,
    resolvedOptions.projectRoot,
  );

  return b;
}

describe('cache', function () {
  before(async () => {
    await inputFS.rimraf(path.join(__dirname, 'input'));
  });

  beforeEach(() => {
    inputDir = path.join(
      __dirname,
      '/input',
      Math.random().toString(36).slice(2),
    );
  });

  it('should support updating a JS file', async function () {
    let b = await testCache(async b => {
      assert.equal(await run(b.bundleGraph), 4);
      await overlayFS.writeFile(
        path.join(inputDir, 'src/nested/test.js'),
        'export default 4',
      );
    });

    assert.equal(await run(b.bundleGraph), 6);
  });

  it('should support adding a dependency', async function () {
    let b = await testCache(async b => {
      assert.equal(await run(b.bundleGraph), 4);
      await overlayFS.writeFile(
        path.join(inputDir, 'src/nested/foo.js'),
        'export default 6',
      );
      await overlayFS.writeFile(
        path.join(inputDir, 'src/nested/test.js'),
        'export {default} from "./foo";',
      );
    });

    assert.equal(await run(b.bundleGraph), 8);
  });

  it('should support adding a dependency which changes the referenced bundles of a parent bundle', async function () {
    async function exec(bundleGraph, bundle) {
      let calls = [];
      await runSingleBundle(bundleGraph, nullthrows(bundle), {
        call(v) {
          calls.push(v);
        },
      });
      return calls;
    }

    let b = await testCache(
      {
        entries: ['a.html', 'b.html'],
        mode: 'production',
        update: async b => {
          let html = b.bundleGraph.getBundles().filter(b => b.type === 'html');
          assert.deepEqual(await exec(b.bundleGraph, html[0]), ['a']);
          assert.deepEqual(await exec(b.bundleGraph, html[1]), ['b']);
          await overlayFS.writeFile(
            path.join(inputDir, 'a.js'),
            'import "./c.js"; call("a");',
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'b.js'),
            'import "./c.js"; call("b");',
          );
        },
      },
      'cache-add-dep-referenced',
    );

    let html = b.bundleGraph.getBundles().filter(b => b.type === 'html');
    assert.deepEqual(await exec(b.bundleGraph, html[0]), ['c', 'a']);
    assert.deepEqual(await exec(b.bundleGraph, html[1]), ['c', 'b']);
  });

  it('should error when deleting a file', async function () {
    // $FlowFixMe
    await assert.rejects(
      async () => {
        await testCache(async () => {
          await overlayFS.unlink(path.join(inputDir, 'src/nested/test.js'));
        });
      },
      {message: "Failed to resolve './nested/test' from './src/index.js'"},
    );
  });

  it('should error when starting parcel from a broken state with no changes', async function () {
    // $FlowFixMe
    await assert.rejects(async () => {
      await testCache(async () => {
        await overlayFS.unlink(path.join(inputDir, 'src/nested/test.js'));
      });
    });

    // Do a third build from a failed state with no changes
    // $FlowFixMe
    await assert.rejects(
      async () => {
        await runBundle();
      },
      {message: "Failed to resolve './nested/test' from './src/index.js'"},
    );
  });

  describe('babel', function () {
    let json = config => JSON.stringify(config);
    let cjs = config => `module.exports = ${JSON.stringify(config)}`;
    // TODO: not sure how to invalidate the ESM cache in node...
    // let mjs = (config) => `export default ${JSON.stringify(config)}`;
    let configs = [
      {name: '.babelrc', formatter: json, nesting: true},
      {name: '.babelrc.json', formatter: json, nesting: true},
      {name: '.babelrc.js', formatter: cjs, nesting: true},
      {name: '.babelrc.cjs', formatter: cjs, nesting: true},
      // {name: '.babelrc.mjs', formatter: mjs, nesting: true},
      {name: 'babel.config.json', formatter: json, nesting: false},
      {name: 'babel.config.js', formatter: cjs, nesting: false},
      {name: 'babel.config.cjs', formatter: cjs, nesting: false},
      // {name: 'babel.config.mjs', formatter: mjs, nesting: false},
    ];

    before(async () => {
      // Invalidate @babel/core before any of these tests run so that it is required
      // through NodePackageManager and we are able to track module children.
      // Otherwise, it will already have been loaded by @babel/register.
      await workerFarm.callAllWorkers('invalidateRequireCache', [
        packageManager.resolveSync('@babel/core', __filename)?.resolved,
      ]);
    });

    for (let {name, formatter, nesting} of configs) {
      describe(name, function () {
        it(`should support adding a ${name}`, async function () {
          let b = await testCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(inputDir);
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                inputDir,
              );
            },
            async update(b) {
              assert.equal(await run(b.bundleGraph), 4);

              let contents = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                contents.includes('class Test'),
                'class should not be transpiled',
              );

              await inputFS.writeFile(
                path.join(inputDir, name),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );

              await sleep(100);
            },
          });

          assert.equal(await run(b.bundleGraph), 4);

          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('class Test'),
            'class should be transpiled',
          );
        });

        it(`should support updating a ${name}`, async function () {
          let b = await testCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(inputDir);
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                inputDir,
              );
              await inputFS.writeFile(
                path.join(inputDir, name),
                formatter({
                  presets: [
                    ['@babel/preset-env', {targets: {esmodules: true}}],
                  ],
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                contents.includes('class Test'),
                'class should not be transpiled',
              );

              await inputFS.writeFile(
                path.join(inputDir, name),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );

              await sleep(100);
            },
          });

          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('class Test'),
            'class should be transpiled',
          );
        });

        it(`should support deleting a ${name}`, async function () {
          let b = await testCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(inputDir);
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                inputDir,
              );
              await inputFS.writeFile(
                path.join(inputDir, name),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                !contents.includes('class Test'),
                'class should be transpiled',
              );

              await inputFS.unlink(path.join(inputDir, name));
              await sleep(100);
            },
          });

          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('class Test'),
            'class should not be transpiled',
          );
        });

        it(`should support updating an extended ${name}`, async function () {
          let extendedName = '.babelrc-extended' + path.extname(name);
          let b = await testCache({
            // Babel's config loader only works with the node filesystem
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(inputDir);
              await inputFS.ncp(
                path.join(__dirname, '/integration/cache'),
                inputDir,
              );
              await inputFS.writeFile(
                path.join(inputDir, extendedName),
                formatter({
                  presets: [
                    ['@babel/preset-env', {targets: {esmodules: true}}],
                  ],
                }),
              );
              await inputFS.writeFile(
                path.join(inputDir, name),
                formatter({
                  extends: `./${extendedName}`,
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(
                contents.includes('class Test'),
                'class should not be transpiled',
              );

              await inputFS.writeFile(
                path.join(inputDir, extendedName),
                formatter({
                  presets: ['@babel/preset-env'],
                }),
              );

              await sleep(100);
            },
          });

          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('class Test'),
            'class should be transpiled',
          );
        });

        if (nesting) {
          it(`should support adding a nested ${name}`, async function () {
            let b = await testCache({
              // Babel's config loader only works with the node filesystem
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.mkdirp(inputDir);
                await inputFS.ncp(
                  path.join(__dirname, '/integration/cache'),
                  inputDir,
                );
              },
              async update(b) {
                assert.equal(await run(b.bundleGraph), 4);

                let contents = await overlayFS.readFile(
                  b.bundleGraph.getBundles()[0].filePath,
                  'utf8',
                );
                assert(
                  contents.includes('class Test'),
                  'class should not be transpiled',
                );
                assert(
                  contents.includes('class Result'),
                  'class should not be transpiled',
                );

                await inputFS.writeFile(
                  path.join(inputDir, `src/nested/${name}`),
                  formatter({
                    presets: ['@babel/preset-env'],
                  }),
                );

                await sleep(100);
              },
            });

            assert.equal(await run(b.bundleGraph), 4);

            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !contents.includes('class Test'),
              'class should be transpiled',
            );
            assert(
              contents.includes('class Result'),
              'class should not be transpiled',
            );
          });

          it(`should support updating a nested ${name}`, async function () {
            let b = await testCache({
              // Babel's config loader only works with the node filesystem
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.mkdirp(inputDir);
                await inputFS.ncp(
                  path.join(__dirname, '/integration/cache'),
                  inputDir,
                );
                await inputFS.writeFile(
                  path.join(inputDir, `src/nested/${name}`),
                  formatter({
                    presets: [
                      ['@babel/preset-env', {targets: {esmodules: true}}],
                    ],
                  }),
                );
              },
              async update(b) {
                let contents = await overlayFS.readFile(
                  b.bundleGraph.getBundles()[0].filePath,
                  'utf8',
                );
                assert(
                  contents.includes('class Test'),
                  'class should not be transpiled',
                );
                assert(
                  contents.includes('class Result'),
                  'class should not be transpiled',
                );

                await inputFS.writeFile(
                  path.join(inputDir, `src/nested/${name}`),
                  formatter({
                    presets: ['@babel/preset-env'],
                  }),
                );

                await sleep(100);
              },
            });

            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !contents.includes('class Test'),
              'class should be transpiled',
            );
            assert(
              contents.includes('class Result'),
              'class should not be transpiled',
            );
          });

          it(`should support deleting a nested ${name}`, async function () {
            let b = await testCache({
              // Babel's config loader only works with the node filesystem
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.mkdirp(inputDir);
                await inputFS.ncp(
                  path.join(__dirname, '/integration/cache'),
                  inputDir,
                );
                await inputFS.writeFile(
                  path.join(inputDir, `src/nested/${name}`),
                  formatter({
                    presets: ['@babel/preset-env'],
                  }),
                );
              },
              async update(b) {
                let contents = await overlayFS.readFile(
                  b.bundleGraph.getBundles()[0].filePath,
                  'utf8',
                );
                assert(
                  !contents.includes('class Test'),
                  'class should be transpiled',
                );
                assert(
                  contents.includes('class Result'),
                  'class should not be transpiled',
                );

                await inputFS.unlink(path.join(inputDir, `src/nested/${name}`));
                await sleep(100);
              },
            });

            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('class Test'),
              'class should not be transpiled',
            );
            assert(
              contents.includes('class Result'),
              'class should not be transpiled',
            );
          });
        }
      });
    }

    describe('.babelignore', function () {
      it('should support adding a .babelignore', async function () {
        let b = await testCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelrc'),
              JSON.stringify({
                presets: ['@babel/preset-env'],
              }),
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !contents.includes('class Test'),
              'class should be transpiled',
            );
            assert(
              !contents.includes('class Result'),
              'class should be transpiled',
            );

            await inputFS.writeFile(
              path.join(inputDir, '.babelignore'),
              'src/nested',
            );

            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          contents.includes('class Test'),
          'class should not be transpiled',
        );
        assert(
          !contents.includes('class Result'),
          'class should be transpiled',
        );
      });

      it('should support updating a .babelignore', async function () {
        let b = await testCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelrc'),
              JSON.stringify({
                presets: ['@babel/preset-env'],
              }),
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelignore'),
              'src/nested',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('class Test'),
              'class should not be transpiled',
            );
            assert(
              !contents.includes('class Result'),
              'class should be transpiled',
            );

            await inputFS.writeFile(path.join(inputDir, '.babelignore'), 'src');
            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          contents.includes('class Test'),
          'class should not be transpiled',
        );
        assert(
          contents.includes('class Result'),
          'class should not be transpiled',
        );
      });

      it('should support deleting a .babelignore', async function () {
        let b = await testCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelrc'),
              JSON.stringify({
                presets: ['@babel/preset-env'],
              }),
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelignore'),
              'src/nested',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('class Test'),
              'class should not be transpiled',
            );
            assert(
              !contents.includes('class Result'),
              'class should be transpiled',
            );

            await inputFS.unlink(path.join(inputDir, '.babelignore'));
            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(!contents.includes('class Test'), 'class should be transpiled');
        assert(
          !contents.includes('class Result'),
          'class should be transpiled',
        );
      });
    });

    describe('plugins', function () {
      it('should invalidate when plugins are updated', async function () {
        let b = await testCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );
            await inputFS.mkdirp(
              path.join(inputDir, 'node_modules/babel-plugin-dummy'),
            );
            await inputFS.writeFile(
              path.join(
                inputDir,
                '/node_modules/babel-plugin-dummy/package.json',
              ),
              JSON.stringify({
                name: 'babel-plugin-dummy',
                version: '1.0.0',
              }),
            );
            await inputFS.copyFile(
              path.join(
                __dirname,
                '/integration/babelrc-custom/babel-plugin-dummy.js',
              ),
              path.join(inputDir, '/node_modules/babel-plugin-dummy/index.js'),
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelrc'),
              JSON.stringify({
                plugins: ['babel-plugin-dummy'],
              }),
            );
            await inputFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              'console.log("REPLACE_ME")',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('hello there'),
              'string should be replaced',
            );

            let plugin = path.join(
              inputDir,
              'node_modules/babel-plugin-dummy/index.js',
            );
            let source = await inputFS.readFile(plugin, 'utf8');
            await inputFS.writeFile(
              plugin,
              source.replace('hello there', 'replaced'),
            );

            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });

      it('should invalidate when there are relative plugins', async function () {
        let b = await testCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );
            await inputFS.copyFile(
              path.join(
                __dirname,
                '/integration/babelrc-custom/babel-plugin-dummy.js',
              ),
              path.join(inputDir, 'babel-plugin-dummy.js'),
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelrc'),
              JSON.stringify({
                plugins: ['./babel-plugin-dummy'],
              }),
            );
            await inputFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              'console.log("REPLACE_ME")',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('hello there'),
              'string should be replaced',
            );

            let plugin = path.join(inputDir, 'babel-plugin-dummy.js');
            let source = await inputFS.readFile(plugin, 'utf8');
            await inputFS.writeFile(
              plugin,
              source.replace('hello there', 'replaced'),
            );

            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });

      it('should invalidate when there are symlinked plugins', async function () {
        // Symlinks don't work consistently on windows. Skip this test.
        if (process.platform === 'win32') {
          this.skip();
          return;
        }

        let b = await testCache({
          // Babel's config loader only works with the node filesystem
          inputFS,
          outputFS: inputFS,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );
            await inputFS.mkdirp(
              path.join(inputDir, 'packages/babel-plugin-dummy'),
            );
            await inputFS.mkdirp(path.join(inputDir, 'node_modules'));
            fs.symlinkSync(
              path.join(inputDir, 'packages/babel-plugin-dummy'),
              path.join(inputDir, 'node_modules/babel-plugin-dummy'),
            );
            await inputFS.writeFile(
              path.join(inputDir, 'packages/babel-plugin-dummy/package.json'),
              JSON.stringify({
                name: 'babel-plugin-dummy',
                version: '1.0.0',
              }),
            );
            await inputFS.copyFile(
              path.join(
                __dirname,
                '/integration/babelrc-custom/babel-plugin-dummy.js',
              ),
              path.join(inputDir, 'packages/babel-plugin-dummy/index.js'),
            );
            await inputFS.writeFile(
              path.join(inputDir, '.babelrc'),
              JSON.stringify({
                plugins: ['babel-plugin-dummy'],
              }),
            );
            await inputFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              'console.log("REPLACE_ME")',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              contents.includes('hello there'),
              'string should be replaced',
            );

            let plugin = path.join(
              inputDir,
              'packages/babel-plugin-dummy/index.js',
            );
            let source = await inputFS.readFile(plugin, 'utf8');
            await inputFS.writeFile(
              plugin,
              source.replace('hello there', 'replaced'),
            );

            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });
    });
  });

  describe('parcel config', function () {
    it('should support adding a .parcelrc', async function () {
      let b = await testCache(async b => {
        assert.equal(await run(b.bundleGraph), 4);

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(!contents.includes('TRANSFORMED CODE'));

        await overlayFS.writeFile(
          path.join(inputDir, '.parcelrc'),
          JSON.stringify({
            extends: '@parcel/config-default',
            transformers: {
              '*.js': ['parcel-transformer-mock'],
            },
          }),
        );
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('TRANSFORMED CODE'));
    });

    it('should support updating a .parcelrc', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('TRANSFORMED CODE'));

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should support updating an extended .parcelrc', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc-extended'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: './.parcelrc-extended',
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc-extended'),
            JSON.stringify({
              extends: '@parcel/config-default',
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('TRANSFORMED CODE'));

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should error when deleting an extended parcelrc', async function () {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache({
            async setup() {
              await overlayFS.writeFile(
                path.join(inputDir, '.parcelrc-extended'),
                JSON.stringify({
                  extends: '@parcel/config-default',
                  transformers: {
                    '*.js': ['parcel-transformer-mock'],
                  },
                }),
              );

              await overlayFS.writeFile(
                path.join(inputDir, '.parcelrc'),
                JSON.stringify({
                  extends: './.parcelrc-extended',
                }),
              );
            },
            async update(b) {
              let contents = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(contents.includes('TRANSFORMED CODE'));

              await overlayFS.unlink(path.join(inputDir, '.parcelrc-extended'));
            },
          });
        },
        {message: 'Cannot find extended parcel config'},
      );
    });

    it('should support deleting a .parcelrc', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('TRANSFORMED CODE'));

          await overlayFS.unlink(path.join(inputDir, '.parcelrc'));
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('TRANSFORMED CODE'));

      assert.equal(await run(b.bundleGraph), 4);
    });
  });

  describe('transformations', function () {
    it('should invalidate when included files changes', async function () {
      let b = await testCache({
        // TODO: update when the fs transform supports the MemoryFS
        inputFS,
        outputFS: inputFS,
        async setup() {
          await inputFS.mkdirp(inputDir);
          await inputFS.ncp(
            path.join(__dirname, '/integration/cache'),
            inputDir,
          );
          await inputFS.writeFile(path.join(inputDir, 'src/test.txt'), 'hi');

          await inputFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("fs").readFileSync(__dirname + "/test.txt", "utf8")',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 'hi');

          await inputFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'updated',
          );

          await sleep(100);
        },
      });

      assert.equal(await run(b.bundleGraph), 'updated');
    });

    it('should not invalidate when a set environment variable does not change', async () => {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');

          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = process.env.TEST',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 'hi');

          await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');
        },
      });

      assert.equal(await run(b.bundleGraph), 'hi');
      assert.equal(b.changedAssets.size, 0);
    });

    it('should not invalidate when an environment variable remains unset', async () => {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = process.env.TEST',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), undefined);
        },
      });

      assert.equal(await run(b.bundleGraph), undefined);
      assert.equal(b.changedAssets.size, 0);
    });

    it('should invalidate when an environment variable becomes set', async () => {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = process.env.TEST',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), undefined);
          await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');
        },
      });

      assert.equal(await run(b.bundleGraph), 'hi');
    });

    it('should invalidate when an environment variable becomes unset', async () => {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = process.env.TEST',
          );
          await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 'hi');
          await overlayFS.writeFile(path.join(inputDir, '.env'), '');
        },
      });

      assert.equal(await run(b.bundleGraph), undefined);
    });

    it('should invalidate when environment variables change', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');

          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = process.env.TEST',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 'hi');

          await overlayFS.writeFile(
            path.join(inputDir, '.env'),
            'TEST=updated',
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 'updated');
    });

    describe('config keys', () => {
      it(`should not invalidate when package.json config keys don't change`, async function () {
        let b = await testCache({
          featureFlags: {
            exampleFeature: false,
          },
          async setup() {
            let pkgFile = path.join(inputDir, 'package.json');
            let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
            await overlayFS.writeFile(
              pkgFile,
              JSON.stringify({
                ...pkg,
                '@parcel/transformer-js': {
                  inlineEnvironment: false,
                  inlineFS: false,
                },
              }),
            );

            await overlayFS.writeFile(
              path.join(inputDir, '.parcelrc'),
              JSON.stringify({
                extends: '@parcel/config-default',
                transformers: {
                  // Remove react-refresh transformer and babel so we don't get extra config deps
                  '*.js': ['@parcel/transformer-js'],
                },
              }),
            );

            await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');

            await overlayFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              'module.exports = process.env.TEST || "default"',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'src/package.json'),
              '{}',
            );
          },
          async update() {
            let pkgFile = path.join(inputDir, 'package.json');
            let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
            await overlayFS.writeFile(
              pkgFile,
              JSON.stringify({
                ...pkg,
                inlineFS: false,
                inlineEnvironment: false,
              }),
            );
          },
        });

        assert.equal(await run(b.bundleGraph), 'default');
        assert.equal(b.changedAssets.size, 0);
      });

      it('should invalidate when package.json config keys change', async function () {
        let b = await testCache({
          featureFlags: {
            exampleFeature: false,
          },
          async setup() {
            let pkgFile = path.join(inputDir, 'package.json');
            let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
            await overlayFS.writeFile(
              pkgFile,
              JSON.stringify({
                ...pkg,
                '@parcel/transformer-js': {
                  inlineEnvironment: false,
                },
              }),
            );

            await overlayFS.writeFile(
              path.join(inputDir, '.parcelrc'),
              JSON.stringify({
                extends: '@parcel/config-default',
                transformers: {
                  // Remove react-refresh transformer and babel so we don't get extra config deps
                  '*.js': ['@parcel/transformer-js'],
                },
              }),
            );

            await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');

            await overlayFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              'module.exports = process.env.TEST || "default"',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'src/package.json'),
              '{}',
            );
          },
          async update() {
            let pkgFile = path.join(inputDir, 'package.json');
            let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
            await overlayFS.writeFile(
              pkgFile,
              JSON.stringify({
                ...pkg,
                '@parcel/transformer-js': {
                  inlineEnvironment: ['TEST'],
                },
              }),
            );
          },
        });

        assert.equal(await run(b.bundleGraph), 'hi');
        assert.equal(b.changedAssets.size, 1);
      });

      it('should invalidate when package.json config keys are removed', async function () {
        let b = await testCache({
          featureFlags: {
            exampleFeature: false,
          },
          async setup() {
            let pkgFile = path.join(inputDir, 'package.json');
            let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
            await overlayFS.writeFile(
              pkgFile,
              JSON.stringify({
                ...pkg,
                '@parcel/transformer-js': {
                  inlineEnvironment: false,
                },
              }),
            );

            await overlayFS.writeFile(
              path.join(inputDir, '.parcelrc'),
              JSON.stringify({
                extends: '@parcel/config-default',
                transformers: {
                  // Remove react-refresh transformer and babel so we don't get extra config deps
                  '*.js': ['@parcel/transformer-js'],
                },
              }),
            );

            await overlayFS.writeFile(path.join(inputDir, '.env'), 'TEST=hi');

            await overlayFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              'module.exports = process.env.TEST || "default"',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'src/package.json'),
              '{}',
            );
          },
          async update() {
            let pkgFile = path.join(inputDir, 'package.json');
            let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
            delete pkg['@parcel/transformer-js'];
            await overlayFS.writeFile(
              pkgFile,
              JSON.stringify({
                pkg,
              }),
            );
          },
        });

        assert.equal(await run(b.bundleGraph), 'hi');
        assert.equal(b.changedAssets.size, 1);
      });
    });
  });

  describe('entries', function () {
    it('should support adding an entry that matches a glob', async function () {
      let b = await testCache({
        entries: ['src/entries/*.js'],
        async update(b) {
          assertBundles(b.bundleGraph, [
            {
              name: 'a.js',
              assets: ['a.js', 'esmodule-helpers.js'],
            },
            {
              name: 'b.js',
              assets: ['b.js', 'esmodule-helpers.js'],
            },
          ]);

          await overlayFS.writeFile(
            path.join(inputDir, 'src/entries/c.js'),
            'export let c = "c";',
          );
        },
      });

      assertBundles(b.bundleGraph, [
        {
          name: 'a.js',
          assets: ['a.js', 'esmodule-helpers.js'],
        },
        {
          name: 'b.js',
          assets: ['b.js', 'esmodule-helpers.js'],
        },
        {
          name: 'c.js',
          assets: ['c.js', 'esmodule-helpers.js'],
        },
      ]);
    });

    it('should support deleting an entry that matches a glob', async function () {
      let b = await testCache({
        entries: ['src/entries/*.js'],
        async update(b) {
          assertBundles(b.bundleGraph, [
            {
              name: 'a.js',
              assets: ['a.js', 'esmodule-helpers.js'],
            },
            {
              name: 'b.js',
              assets: ['b.js', 'esmodule-helpers.js'],
            },
          ]);

          await overlayFS.unlink(path.join(inputDir, 'src/entries/b.js'));
        },
      });

      assertBundles(b.bundleGraph, [
        {
          name: 'a.js',
          assets: ['a.js', 'esmodule-helpers.js'],
        },
      ]);
    });

    it('should error when deleting a file entry', async function () {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache(async () => {
            await overlayFS.unlink(path.join(inputDir, 'src/index.js'));
          });
        },
        {
          message: md`Entry ${path.join(
            inputDir,
            'src/index.js',
          )} does not exist`,
        },
      );
    });

    it('should recover from errors when adding a missing entry', async function () {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache(async () => {
            await overlayFS.unlink(path.join(inputDir, 'src/index.js'));
          });
        },
        {
          message: md`Entry ${path.join(
            inputDir,
            'src/index.js',
          )} does not exist`,
        },
      );

      await overlayFS.writeFile(
        path.join(inputDir, 'src/index.js'),
        'module.exports = "hi"',
      );

      let b = await runBundle();
      assert.equal(await run(b.bundleGraph), 'hi');
    });
  });

  describe('target config', function () {
    it('should support adding a target config', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!contents.includes('export '), 'should not include export');

          let pkgFile = path.join(inputDir, 'package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'esmodule',
                  isLibrary: true,
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('export '), 'should include export');
    });

    it('should support adding a second target', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b.bundleGraph, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
      });

      assertBundles(b.bundleGraph, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);
    });

    it('should support changing target output location', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              modern: 'modern/index.js',
              legacy: 'legacy/index.js',
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
        async update() {
          assert(
            await overlayFS.exists(path.join(inputDir, 'modern/index.js')),
          );
          assert(
            await overlayFS.exists(path.join(inputDir, 'legacy/index.js')),
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              modern: 'dist/modern/index.js',
              legacy: 'dist/legacy/index.js',
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
      });

      assert(
        await overlayFS.exists(path.join(inputDir, 'dist/modern/index.js')),
      );
      assert(
        await overlayFS.exists(path.join(inputDir, 'dist/legacy/index.js')),
      );
    });

    it('should support updating target config options', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'esmodule',
                  isLibrary: true,
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('export '), 'should include export');

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'commonjs',
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('module.exports ='),
        'should include module.exports =',
      );
    });

    it('should support deleting a target', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b.bundleGraph, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
              },
            }),
          );
        },
      });

      assertBundles(b.bundleGraph, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);
    });

    it('should support deleting all targets', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
                  isLibrary: true,
                },
                legacy: {
                  outputFormat: 'commonjs',
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b.bundleGraph, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('export '), 'should include export');

          contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[1].filePath,
            'utf8',
          );
          assert(
            contents.includes('module.exports ='),
            'should include module.exports',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: undefined,
            }),
          );
        },
      });

      assertBundles(b.bundleGraph, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('export '), 'should not include export');
      assert(
        !contents.includes('module.exports ='),
        'should not include module.exports',
      );
    });

    it('should update when sourcemap options change', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  sourceMap: true,
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('sourceMappingURL=index.js.map'),
            'should include sourceMappingURL',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  sourceMap: {
                    inline: true,
                  },
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('sourceMappingURL=data:application/json'),
        'should include inline sourceMappingURL',
      );
    });

    it('should update when publicUrl changes', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        entries: ['src/index.html'],
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  publicUrl: 'http://example.com/',
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('<script type="module" src="http://example.com'),
            'should include example.com',
          );

          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  publicUrl: 'http://mygreatwebsite.com/',
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes(
          '<script type="module" src="http://mygreatwebsite.com',
        ),
        'should include example.com',
      );
    });

    it('should update when a package.json is created', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let pkg;
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.unlink(pkgFile);
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!contents.includes('export '), 'does not include export');

          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
                  isLibrary: true,
                },
              },
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('export '), 'should include export');
    });

    it('should update when a package.json is deleted', async function () {
      let pkgFile = path.join(inputDir, 'package.json');
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
                  isLibrary: true,
                },
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('export '), 'should include export');
          await overlayFS.unlink(pkgFile);
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('export '), 'does not include export');
    });

    describe('browserslist', function () {
      it('should update when a browserslist file is added', async function () {
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              /class \$[a-f0-9]+\$var\$Test/.test(contents),
              'should include class',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'browserslist'),
              'IE >= 11',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          !/class \$[a-f0-9]+\$var\$Test/.test(contents),
          'does not include class',
        );
      });

      it('should update when a .browserslistrc file is added', async function () {
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              /class \$[a-f0-9]+\$var\$Test/.test(contents),
              'should include class',
            );
            await overlayFS.writeFile(
              path.join(inputDir, '.browserslistrc'),
              'IE >= 11',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          !/class \$[a-f0-9]+\$var\$Test/.test(contents),
          'does not include class',
        );
      });

      it('should update when a browserslist is updated', async function () {
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          async setup() {
            await overlayFS.writeFile(
              path.join(inputDir, 'browserslist'),
              'IE >= 11',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'browserslist'),
              'last 1 Chrome version',
            );
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );
      });

      it('should update when a browserslist is deleted', async function () {
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          async setup() {
            await overlayFS.writeFile(
              path.join(inputDir, 'browserslist'),
              'IE >= 11',
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );
            await overlayFS.unlink(path.join(inputDir, 'browserslist'));
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );
      });

      it('should update when BROWSERSLIST_ENV changes', async function () {
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          async setup() {
            await overlayFS.writeFile(
              path.join(inputDir, 'browserslist'),
              `
            [production]
            IE >= 11

            [development]
            last 1 Chrome version
            `,
            );

            process.env.BROWSERSLIST_ENV = 'production';
          },
          async update(b) {
            // "production" is the default environment for browserslist
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );

            process.env.BROWSERSLIST_ENV = 'development';
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );

        delete process.env.BROWSERSLIST_ENV;
      });

      it('should update when NODE_ENV changes', async function () {
        let env = process.env.NODE_ENV;
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          async setup() {
            await overlayFS.writeFile(
              path.join(inputDir, 'browserslist'),
              `
            [production]
            IE >= 11

            [development]
            last 1 Chrome version
            `,
            );

            process.env.NODE_ENV = 'production';
          },
          async update(b) {
            // "production" is the default environment for browserslist
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(
              !/class \$[a-f0-9]+\$var\$Test/.test(contents),
              'does not include class',
            );

            process.env.NODE_ENV = 'development';
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(
          /class \$[a-f0-9]+\$var\$Test/.test(contents),
          'should include class',
        );

        process.env.NODE_ENV = env;
      });
    });
  });

  describe('options', function () {
    it('should update when publicUrl changes', async function () {
      let b = await testCache({
        entries: ['src/index.html'],
        defaultTargetOptions: {
          shouldScopeHoist: true,
          publicUrl: 'http://example.com/',
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('<script type="module" src="http://example.com'),
            'should include example.com',
          );

          return {
            defaultTargetOptions: {
              publicUrl: 'http://mygreatwebsite.com/',
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes(
          '<script type="module" src="http://mygreatwebsite.com',
        ),
        'should include example.com',
      );
    });

    it('should update when minify changes', async function () {
      let b = await testCache({
        entries: ['src/index.html'],
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[1].filePath,
            'utf8',
          );
          assert(contents.includes('Test'), 'should include Test');

          return {
            defaultTargetOptions: {
              shouldScopeHoist: true,
              shouldOptimize: true,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[1].filePath,
        'utf8',
      );
      assert(!contents.includes('Test'), 'should not include Test');
    });

    it('should update when scopeHoist changes', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('parcelRequire'),
            'should include parcelRequire',
          );

          return {
            defaultTargetOptions: {
              shouldScopeHoist: true,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('parcelRequire'), 'should not include Test');
    });

    it('should update when sourceMaps changes', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          sourceMaps: false,
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('sourceMappingURL=index.js.map'),
            'should not include sourceMappingURL',
          );

          return {
            defaultTargetOptions: {
              sourceMaps: true,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('sourceMappingURL=index.js.map'),
        'should include sourceMappingURL',
      );
    });

    it('should update when distDir changes', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        update(b) {
          assert(
            /dist[/\\]index.js$/.test(b.bundleGraph.getBundles()[0].filePath),
            'should end with dist/index.js',
          );

          return {
            defaultTargetOptions: {
              distDir: path.join(__dirname, 'integration/cache/dist/test'),
            },
          };
        },
      });

      assert(
        /dist[/\\]test[/\\]index.js$/.test(
          b.bundleGraph.getBundles()[0].filePath,
        ),
        'should end with dist/test/index.js',
      );
    });

    it('should update when targets changes', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        targets: ['legacy'],
        async setup() {
          let pkgFile = path.join(inputDir, 'package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  engines: {
                    browsers: 'last 1 Chrome version',
                  },
                },
                legacy: {
                  engines: {
                    browsers: 'IE 11',
                  },
                },
              },
            }),
          );
        },
        async update(b) {
          assertBundles(b.bundleGraph, [
            {
              name: 'index.js',
              assets: ['index.js', 'test.js', 'foo.js'],
            },
          ]);

          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !/class \$[a-f0-9]+\$var\$Test/.test(contents),
            'should not include class',
          );

          return {
            targets: ['modern'],
          };
        },
      });

      assertBundles(b.bundleGraph, [
        {
          name: 'index.js',
          assets: ['index.js', 'test.js', 'foo.js'],
        },
      ]);

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        /class \$[a-f0-9]+\$var\$Test/.test(contents),
        'should include class',
      );
    });

    it('should update when defaultEngines changes', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
          engines: {
            browsers: 'last 1 Chrome version',
          },
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            /class \$[a-f0-9]+\$var\$Test/.test(contents),
            'should include class',
          );

          return {
            defaultTargetOptions: {
              shouldScopeHoist: true,
              engines: {
                browsers: 'IE 11',
              },
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        !/class \$[a-f0-9]+\$var\$Test/.test(contents),
        'should not include class',
      );
    });

    it('should update when shouldContentHash changes', async function () {
      let b = await testCache({
        entries: ['src/index.html'],
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        shouldContentHash: true,
        update(b) {
          let bundle = b.bundleGraph.getBundles()[1];
          assert(!bundle.filePath.includes(bundle.id.slice(-8)));

          return {
            shouldContentHash: false,
          };
        },
      });

      let bundle = b.bundleGraph.getBundles()[1];
      assert(bundle.filePath.includes(bundle.id.slice(-8)));
    });

    it('should update when hmr options change', async function () {
      let b = await testCache({
        hmrOptions: {
          host: 'localhost',
          port: 4321,
        },
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                // Remove react-refresh transformer so we test whether the runtime updates
                '*.js': ['@parcel/transformer-js'],
              },
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes('HMR_HOST = "localhost"'),
            'should include HMR_HOST = "localhost"',
          );
          assert(
            contents.includes('HMR_PORT = 4321'),
            'should include HMR_PORT = 4321',
          );

          return {
            hmrOptions: {
              host: 'example.com',
              port: 5678,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('HMR_HOST = "example.com"'),
        'should include HMR_HOST = "example.com"',
      );
      assert(
        contents.includes('HMR_PORT = 5678'),
        'should include HMR_PORT = 5678',
      );
    });

    it('should invalidate react refresh hot options change', async function () {
      let b = await testCache({
        async setup() {
          let pkgFile = path.join(inputDir, 'package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              dependencies: {
                react: '*',
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            `import React from 'react';

            export function Component() {
              return <h1>Hello world</h1>;
            }`,
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            !contents.includes('getRefreshBoundarySignature'),
            'should not include getRefreshBoundarySignature',
          );

          return {
            hmrOptions: {
              host: 'example.com',
              port: 5678,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes('getRefreshBoundarySignature'),
        'should include getRefreshBoundarySignature',
      );
    });

    it('should update when the config option changes', async function () {
      let b = await testCache({
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(inputDir, 'some-config'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          return {
            config: path.join(inputDir, 'some-config'),
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('TRANSFORMED CODE'));
    });

    it('should update when the defaultConfig option changes', async function () {
      let b = await testCache({
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!contents.includes('TRANSFORMED CODE'));

          await overlayFS.writeFile(
            path.join(inputDir, 'some-config'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          return {
            defaultConfig: path.join(inputDir, 'some-config'),
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('TRANSFORMED CODE'));
    });

    it('should update env browserslist in package.json when mode changes', async function () {
      let env = process.env.NODE_ENV;
      delete process.env.NODE_ENV;
      try {
        let b = await testCache({
          defaultTargetOptions: {
            shouldScopeHoist: false,
            shouldOptimize: false,
          },
          mode: 'development',
          async setup() {
            let pkg = JSON.parse(
              await overlayFS.readFile(
                path.join(inputDir, 'package.json'),
                'utf8',
              ),
            );
            pkg.browserslist = {
              production: ['ie 11'],
              development: ['Chrome 80'],
            };
            await overlayFS.writeFile(
              path.join(inputDir, 'package.json'),
              JSON.stringify(pkg, null, 2),
            );
          },
          async update(b) {
            let contents = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(/class Test/.test(contents), 'should include class');

            return {
              mode: 'production',
            };
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(!/class Test/.test(contents), 'does not include class');
      } finally {
        process.env.NODE_ENV = env;
      }
    });
  });

  describe('resolver', function () {
    it('should support updating a package.json#main field', async function () {
      let b = await testCache(async b => {
        assert.equal(await run(b.bundleGraph), 4);
        await overlayFS.writeFile(
          path.join(inputDir, 'node_modules/foo/test.js'),
          'module.exports = 4;',
        );

        await overlayFS.writeFile(
          path.join(inputDir, 'node_modules/foo/package.json'),
          JSON.stringify({main: 'test.js'}),
        );
      });

      assert.equal(await run(b.bundleGraph), 8);
    });

    it('should support adding an alias', async function () {
      let b = await testCache(async b => {
        assert.equal(await run(b.bundleGraph), 4);
        await overlayFS.writeFile(
          path.join(inputDir, 'node_modules/foo/test.js'),
          'module.exports = 4;',
        );

        await overlayFS.writeFile(
          path.join(inputDir, 'node_modules/foo/package.json'),
          JSON.stringify({
            main: 'foo.js',
            alias: {
              './foo.js': './test.js',
            },
          }),
        );
      });

      assert.equal(await run(b.bundleGraph), 8);
    });

    it('should support updating an alias', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/test.js'),
            'module.exports = 4;',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/package.json'),
            JSON.stringify({
              main: 'foo.js',
              alias: {
                './foo.js': './test.js',
              },
            }),
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 8);
          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/baz.js'),
            'module.exports = 6;',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/package.json'),
            JSON.stringify({
              main: 'foo.js',
              alias: {
                './foo.js': './baz.js',
              },
            }),
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 12);
    });

    it('should support deleting an alias', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/test.js'),
            'module.exports = 4;',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/package.json'),
            JSON.stringify({
              main: 'foo.js',
              alias: {
                './foo.js': './test.js',
              },
            }),
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 8);
          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/package.json'),
            JSON.stringify({main: 'foo.js'}),
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should support adding an alias in a closer package.json', async function () {
      let b = await testCache(async b => {
        assert.equal(await run(b.bundleGraph), 4);
        await overlayFS.writeFile(
          path.join(inputDir, 'src/nested/foo.js'),
          'module.exports = 4;',
        );

        await overlayFS.writeFile(
          path.join(inputDir, 'src/nested/package.json'),
          JSON.stringify({
            alias: {
              './test.js': './foo.js',
            },
          }),
        );
      });

      assert.equal(await run(b.bundleGraph), 6);
    });

    it('should support adding a file with a higher priority extension', async function () {
      let b = await testCache({
        async setup() {
          // Start out pointing to a .ts file from a .js file
          let contents = await overlayFS.readFile(
            path.join(inputDir, 'src/index.js'),
            'utf8',
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            contents.replace('nested/test', 'nested/foo'),
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/foo.ts'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 6);

          // Adding a .js file should be higher priority
          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/foo.js'),
            'module.exports = 2;',
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should support renaming a file to a different extension', async function () {
      let b = await testCache({
        async setup() {
          // Start out pointing to a .js file
          let contents = await overlayFS.readFile(
            path.join(inputDir, 'src/index.js'),
            'utf8',
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            contents.replace('nested/test', 'nested/foo'),
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/foo.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 6);

          // Rename to .ts
          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/foo.ts'),
            'module.exports = 2;',
          );

          await overlayFS.unlink(path.join(inputDir, 'src/nested/foo.js'));
        },
      });

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should resolve to a file over a directory with an index.js', async function () {
      let b = await testCache({
        async setup() {
          let contents = await overlayFS.readFile(
            path.join(inputDir, 'src/index.js'),
            'utf8',
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            contents.replace('nested/test', 'nested'),
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/index.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 6);

          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested.js'),
            'module.exports = 2;',
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should resolve to package.json#main over an index.js', async function () {
      let b = await testCache({
        async setup() {
          let contents = await overlayFS.readFile(
            path.join(inputDir, 'src/index.js'),
            'utf8',
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            contents.replace('nested/test', 'nested'),
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/index.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 6);

          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/package.json'),
            JSON.stringify({
              main: 'test.js',
            }),
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should recover from errors when adding a missing dependency', async function () {
      // $FlowFixMe
      await assert.rejects(
        async () => {
          await testCache({
            async setup() {
              await overlayFS.unlink(path.join(inputDir, 'src/nested/test.js'));
            },
            async update() {},
          });
        },
        {
          message: "Failed to resolve './nested/test' from './src/index.js'",
        },
      );

      await overlayFS.writeFile(
        path.join(inputDir, 'src/nested/test.js'),
        'module.exports = 4;',
      );

      let b = await runBundle();
      assert.equal(await run(b.bundleGraph), 6);
    });

    it('should recover from a missing package.json#main', async function () {
      let b = await testCache({
        async setup() {
          let contents = await overlayFS.readFile(
            path.join(inputDir, 'src/index.js'),
            'utf8',
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            contents.replace('nested/test', 'nested'),
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/package.json'),
            JSON.stringify({
              main: 'tmp.js',
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/index.js'),
            'module.exports = 4;',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 6);

          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/tmp.js'),
            'module.exports = 8;',
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 10);
    });

    it('should recover from an invalid package.json', async function () {
      // $FlowFixMe
      await assert.rejects(async () => {
        await testCache({
          async setup() {
            let contents = await overlayFS.readFile(
              path.join(inputDir, 'src/index.js'),
              'utf8',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'src/index.js'),
              contents.replace('nested/test', 'nested'),
            );

            await overlayFS.writeFile(
              path.join(inputDir, 'src/nested/package.json'),
              'invalid',
            );

            await overlayFS.writeFile(
              path.join(inputDir, 'src/nested/index.js'),
              'module.exports = 10;',
            );
          },
          async update() {},
        });
      });

      await overlayFS.writeFile(
        path.join(inputDir, 'src/nested/package.json'),
        JSON.stringify({
          main: 'test.js',
        }),
      );

      let b = await runBundle();
      assert.equal(await run(b.bundleGraph), 4);
    });

    it('should support adding a deeper node_modules folder', async function () {
      let b = await testCache({
        async update(b) {
          assert.equal(await run(b.bundleGraph), 4);

          await overlayFS.mkdirp(
            path.join(inputDir, 'src/nested/node_modules/foo'),
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/nested/node_modules/foo/index.js'),
            'module.exports = 4;',
          );
        },
      });

      assert.equal(await run(b.bundleGraph), 6);
    });

    it('should invalidate when switching to a different resolver plugin', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            `import "foo";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/foo.js'),
            `export default "FOO";`,
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!res.includes('FOO'));

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              resolvers: ['parcel-resolver-test'],
            }),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(res.includes('FOO'));
    });

    it('should invalidate when a resolver is updated', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            `import "foo";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/foo.js'),
            `export default "FOO";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/foo.ts'),
            `export default "BAR";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              resolvers: ['parcel-resolver-test'],
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(res.includes('FOO'));
          assert(!res.includes('BAR'));

          let resolver = path.join(
            inputDir,
            'node_modules',
            'parcel-resolver-test',
            'index.js',
          );
          await overlayFS.writeFile(
            resolver,
            (
              await overlayFS.readFile(resolver, 'utf8')
            ).replace(/\.js/g, '.ts'),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!res.includes('FOO'));
      assert(res.includes('BAR'));
    });

    it('should invalidate when adding resolver config', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            `import "foo";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/foo.js'),
            `export default "FOO";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/bar.js'),
            `export default "BAR";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              resolvers: ['parcel-resolver-test'],
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(res.includes('FOO'));
          assert(!res.includes('BAR'));

          await overlayFS.writeFile(
            path.join(inputDir, '.resolverrc'),
            JSON.stringify({foo: 'bar.js'}),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!res.includes('FOO'));
      assert(res.includes('BAR'));
    });

    it('should invalidate when updating resolver config', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            `import "foo";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/foo.js'),
            `export default "FOO";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/bar.js'),
            `export default "BAR";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              resolvers: ['parcel-resolver-test'],
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.resolverrc'),
            JSON.stringify({foo: 'bar.js'}),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!res.includes('FOO'));
          assert(res.includes('BAR'));

          await overlayFS.writeFile(
            path.join(inputDir, '.resolverrc'),
            JSON.stringify({foo: 'foo.js'}),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(res.includes('FOO'));
      assert(!res.includes('BAR'));
    });

    it('should invalidate when removing resolver config', async function () {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            `import "foo";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/foo.js'),
            `export default "FOO";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, 'src/bar.js'),
            `export default "BAR";`,
          );
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              resolvers: ['parcel-resolver-test'],
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.resolverrc'),
            JSON.stringify({foo: 'bar.js'}),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(!res.includes('FOO'));
          assert(res.includes('BAR'));

          await overlayFS.unlink(path.join(inputDir, '.resolverrc'));
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(res.includes('FOO'));
      assert(!res.includes('BAR'));
    });

    describe('pnp', function () {
      it('should invalidate when the .pnp.js file changes', async function () {
        let Module = require('module');
        let origPnpVersion = process.versions.pnp;
        // $FlowFixMe[prop-missing]
        let origModuleResolveFilename = Module._resolveFilename;

        try {
          let b = await testCache(
            {
              entries: ['index.js'],
              inputFS,
              async setup() {
                await inputFS.mkdirp(inputDir);
                await inputFS.ncp(
                  path.join(__dirname, '/integration/pnp-require'),
                  inputDir,
                );

                // $FlowFixMe[incompatible-type]
                process.versions.pnp = 42;

                // $FlowFixMe[prop-missing]
                Module.findPnpApi = () =>
                  // $FlowFixMe
                  require(path.join(inputDir, '.pnp.js'));

                let pnp = await inputFS.readFile(
                  path.join(inputDir, '.pnp.js'),
                  'utf8',
                );
                await inputFS.writeFile(
                  path.join(inputDir, '.pnp.js'),
                  pnp.replace("'zipfs',", ''),
                );

                await inputFS.mkdirp(path.join(inputDir, 'pnp/testmodule2'));
                await inputFS.writeFile(
                  path.join(inputDir, 'pnp/testmodule2/index.js'),
                  'exports.a = 4;',
                );
              },
              async update(b) {
                let output = await run(b.bundleGraph);
                assert.equal(output(), 3);

                let pnp = await inputFS.readFile(
                  path.join(inputDir, '.pnp.js'),
                  'utf8',
                );
                await inputFS.writeFile(
                  path.join(inputDir, '.pnp.js'),
                  pnp.replace("'pnp', 'testmodule'", "'pnp', 'testmodule2'"),
                );

                delete require.cache[path.join(inputDir, '.pnp.js')];
                await sleep(100);
              },
            },
            'pnp-require',
          );

          let output = await run(b.bundleGraph);
          assert.equal(output(), 6);
        } finally {
          // $FlowFixMe[incompatible-type]
          process.versions.pnp = origPnpVersion;
          // $FlowFixMe[prop-missing]
          Module._resolveFilename = origModuleResolveFilename;
        }
      });
    });

    describe('stylus', function () {
      it('should support resolver inside stylus file', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            async setup() {
              await overlayFS.writeFile(
                path.join(inputDir, 'index.styl'),
                `
            @import "./b";
            .a
              background: red
            `,
              );

              await overlayFS.mkdirp(path.join(inputDir, 'b'));
              await overlayFS.writeFile(
                path.join(inputDir, 'b/index.styl'),
                `
            .b
              background: blue
            `,
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.a {'));
              assert(css.includes('.b {'));
              assert(!css.includes('.c {'));

              await overlayFS.writeFile(
                path.join(inputDir, 'b.styl'),
                `
            .c
              background: blue
            `,
              );
            },
          },
          'stylus',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(css.includes('.a {'));
        assert(!css.includes('.b {'));
        assert(css.includes('.c {'));
      });

      it('should support stylus default resolver', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            async setup() {
              await overlayFS.writeFile(
                path.join(inputDir, '.stylusrc'),
                JSON.stringify({
                  paths: ['deps'],
                }),
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.a {'));
              assert(!css.includes('.b {'));

              await overlayFS.writeFile(
                path.join(inputDir, 'a.styl'),
                `
            .b
              background: blue
            `,
              );
            },
          },
          'stylus-deps',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(!css.includes('.a {'));
        assert(css.includes('.b {'));
      });

      it('should support glob imports in stylus files', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.index'));
              assert(css.includes('.main'));
              assert(css.includes('.foo'));
              assert(css.includes('.bar'));

              await overlayFS.writeFile(
                path.join(inputDir, 'subdir/test.styl'),
                `
            .test
              background: blue
            `,
              );

              await overlayFS.writeFile(
                path.join(inputDir, 'subdir/foo/test.styl'),
                `
            .foo-test
              background: blue
            `,
              );
            },
          },
          'stylus-glob-import',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(css.includes('.index'));
        assert(css.includes('.main'));
        assert(css.includes('.foo'));
        assert(css.includes('.bar'));
        assert(css.includes('.test'));
        assert(css.includes('.foo-test'));
      });

      it('should support glob imports under stylus paths', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            async setup() {
              await overlayFS.writeFile(
                path.join(inputDir, '.stylusrc'),
                JSON.stringify({
                  paths: ['subdir'],
                }),
              );

              await overlayFS.writeFile(
                path.join(inputDir, 'index.styl'),
                `
            @require 'foo/*'

            .index
              color: red
            `,
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.index'));
              assert(!css.includes('.main'));
              assert(css.includes('.foo'));
              assert(!css.includes('.bar'));

              await overlayFS.writeFile(
                path.join(inputDir, 'subdir/test.styl'),
                `
            .test
              background: blue
            `,
              );

              await overlayFS.writeFile(
                path.join(inputDir, 'subdir/foo/test.styl'),
                `
            .foo-test
              background: blue
            `,
              );
            },
          },
          'stylus-glob-import',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(css.includes('.index'));
        assert(!css.includes('.main'));
        assert(css.includes('.foo'));
        assert(!css.includes('.bar'));
        assert(!css.includes('.test'));
        assert(css.includes('.foo-test'));
      });
    });

    describe('less', function () {
      it('should support adding higher priority less include paths', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            async setup() {
              await overlayFS.writeFile(
                path.join(inputDir, '.lessrc'),
                JSON.stringify({
                  paths: ['include-path', 'node_modules/library'],
                }),
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.a'));
              assert(css.includes('.b'));

              await overlayFS.writeFile(
                path.join(inputDir, 'a.less'),
                `.c {
                  background: blue
                }`,
              );

              await overlayFS.writeFile(
                path.join(inputDir, 'include-path/b.less'),
                `.d {
                  background: blue
                }`,
              );
            },
          },
          'less-include-paths',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(!css.includes('.a'));
        assert(!css.includes('.b'));
        assert(css.includes('.c'));
        assert(css.includes('.d'));
      });

      it('should recover from missing import errors', async function () {
        // $FlowFixMe
        await assert.rejects(
          async () => {
            await testCache(
              {
                entries: ['index.js'],
                async setup() {
                  await overlayFS.writeFile(
                    path.join(inputDir, '.lessrc'),
                    JSON.stringify({
                      paths: ['include-path', 'node_modules/library'],
                    }),
                  );

                  await overlayFS.writeFile(
                    path.join(inputDir, 'yarn.lock'),
                    '',
                  );

                  await overlayFS.unlink(
                    path.join(inputDir, 'include-path/a.less'),
                  );
                },
                async update() {},
              },
              'less-include-paths',
            );
          },
          {
            message: "Failed to resolve 'a.less' from './index.less'",
          },
        );

        await overlayFS.writeFile(
          path.join(inputDir, 'include-path/a.less'),
          `.d {
            background: blue
          }`,
        );

        let b = await runBundle('index.js');
        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(css.includes('.d'));
        assert(css.includes('.b'));
      });
    });

    describe('sass', function () {
      it('should support adding higher priority sass include paths', async function () {
        let b = await testCache(
          {
            entries: ['index.sass'],
            async setup() {
              await overlayFS.writeFile(
                path.join(inputDir, '.sassrc'),
                JSON.stringify({
                  includePaths: ['include-path'],
                }),
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.included'));

              await overlayFS.writeFile(
                path.join(inputDir, 'style.sass'),
                `.test
                  background: blue
                `,
              );
            },
          },
          'sass-include-paths-import',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(!css.includes('.included'));
        assert(css.includes('.test'));
      });

      it('should the SASS_PATH environment variable', async function () {
        let b = await testCache(
          {
            entries: ['index.sass'],
            env: {
              SASS_PATH: 'include-path',
            },
            async setup() {
              await overlayFS.mkdirp(path.join(inputDir, 'include2'));
              await overlayFS.rimraf(path.join(inputDir, '.sassrc.js'));
              await overlayFS.writeFile(
                path.join(inputDir, 'include2/style.sass'),
                `.test
                  background: blue
                `,
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                nullthrows(
                  b.bundleGraph.getBundles().find(b => b.type === 'css')
                    ?.filePath,
                ),
                'utf8',
              );
              assert(css.includes('.included'));

              return {
                env: {
                  SASS_PATH: 'include2',
                },
              };
            },
          },
          'sass-include-paths-import',
        );

        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(!css.includes('.included'));
        assert(css.includes('.test'));
      });

      it('should recover from missing import errors', async function () {
        // $FlowFixMe
        await assert.rejects(async () => {
          await testCache(
            {
              entries: ['index.sass'],
              async setup() {
                await overlayFS.writeFile(
                  path.join(inputDir, '.sassrc'),
                  JSON.stringify({
                    includePaths: ['include-path'],
                  }),
                );

                await overlayFS.writeFile(path.join(inputDir, 'yarn.lock'), '');

                await overlayFS.unlink(
                  path.join(inputDir, 'include-path/style.sass'),
                );
              },
              async update() {},
            },
            'sass-include-paths-import',
          );
        });

        await overlayFS.writeFile(
          path.join(inputDir, 'include-path/style.sass'),
          `.d
            background: blue
          `,
        );

        let b = await runBundle('index.sass');
        let css = await overlayFS.readFile(
          nullthrows(
            b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          ),
          'utf8',
        );
        assert(css.includes('.d'));
      });
    });
  });

  describe('dev deps', function () {
    it('should invalidate when updating a parcel transformer plugin', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
        },
        async update(b) {
          let output = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(output.includes('TRANSFORMED CODE'));

          let transformerDir = path.join(
            inputDir,
            'node_modules',
            'parcel-transformer-mock',
          );
          await overlayFS.writeFile(
            path.join(transformerDir, 'constants.js'),
            'exports.message = "UPDATED"',
          );
        },
      });

      let output = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(output.includes('UPDATED'));
    });

    it('should invalidate when updating a file required via options.packageManager.require', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
          let transformer = path.join(
            inputDir,
            'node_modules',
            'parcel-transformer-mock',
            'index.js',
          );
          let contents = await overlayFS.readFile(transformer, 'utf8');
          await overlayFS.writeFile(
            transformer,
            contents
              .replace(
                'transform({asset}) {',
                'async transform({asset, options}) {',
              )
              .replace(
                "const {message} = require('./constants');",
                "const message = 'FOO: ' + await options.packageManager.require('foo', asset.filePath);",
              ),
          );
        },
        async update(b) {
          let output = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(output.includes('FOO: 2'));

          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules', 'foo', 'foo.js'),
            'module.exports = 3;',
          );
        },
      });

      let output = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(output.includes('FOO: 3'));
    });

    it('should resolve to package.json#main over an index.js', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );
        },
        async update(b) {
          let output = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(output.includes('TRANSFORMED CODE'));

          let transformerDir = path.join(
            inputDir,
            'node_modules',
            'parcel-transformer-mock',
          );
          await overlayFS.writeFile(
            path.join(transformerDir, 'MockTransformer.js'),
            `
            const Transformer = require('@parcel/plugin').Transformer;
            module.exports = new Transformer({
              transform({asset}) {
                return [
                  {
                    type: 'js',
                    content: 'UPDATED',
                  },
                ];
              }
            });
            `,
          );

          await overlayFS.writeFile(
            path.join(transformerDir, 'package.json'),
            JSON.stringify({main: 'MockTransformer.js'}),
          );
        },
      });

      let output = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(output.includes('UPDATED'));
    });

    it('should resolve to a file over a directory with an index.js', async function () {
      let transformerDir = path.join(
        inputDir,
        'node_modules',
        'parcel-transformer-mock',
      );
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              transformers: {
                '*.js': ['parcel-transformer-mock'],
              },
            }),
          );

          await overlayFS.unlink(path.join(transformerDir, 'constants.js'));
          await overlayFS.mkdirp(path.join(transformerDir, 'constants'));
          await overlayFS.writeFile(
            path.join(transformerDir, 'constants', 'index.js'),
            'exports.message = "TRANSFORMED"',
          );
        },
        async update(b) {
          let output = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(output.includes('TRANSFORMED'));

          await overlayFS.writeFile(
            path.join(transformerDir, 'constants.js'),
            'exports.message = "UPDATED"',
          );
        },
      });

      let output = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(output.includes('UPDATED'));
    });

    it('should support adding a deeper node_modules folder', async function () {});

    it('should support yarn pnp', async function () {
      let Module = require('module');
      // $FlowFixMe[incompatible-type]
      let origPnpVersion = process.versions.pnp;
      // $FlowFixMe[prop-missing]
      let origModuleResolveFilename = Module._resolveFilename;

      // We must create a worker farm that only uses a single thread because our process.versions.pnp
      // mock won't be available in the workers of the existing farm.
      let workerFarm = createWorkerFarm({
        maxConcurrentWorkers: 0,
      });

      try {
        let b = await testCache({
          inputFS,
          outputFS: inputFS,
          workerFarm,
          async setup() {
            await inputFS.mkdirp(inputDir);
            await inputFS.ncp(
              path.join(__dirname, '/integration/cache'),
              inputDir,
            );

            // $FlowFixMe
            process.versions.pnp = 42;

            fs.renameSync(
              path.join(inputDir, 'node_modules'),
              path.join(inputDir, 'pnp'),
            );

            await inputFS.ncp(
              path.join(inputDir, 'pnp'),
              path.join(inputDir, 'pnp2'),
            );

            await inputFS.writeFile(
              path.join(inputDir, 'pnp', 'parcel-transformer-mock', 'index.js'),
              `
                const Transformer = require('@parcel/plugin').Transformer;
                module.exports = new Transformer({
                  transform({asset}) {
                    return [
                      {
                        type: 'js',
                        content: 'TRANSFORMED CODE',
                      },
                    ];
                  }
                });
                `,
            );

            await inputFS.writeFile(
              path.join(
                inputDir,
                'pnp2',
                'parcel-transformer-mock',
                'index.js',
              ),
              `
                const Transformer = require('@parcel/plugin').Transformer;
                module.exports = new Transformer({
                  transform({asset}) {
                    return [
                      {
                        type: 'js',
                        content: 'UPDATED',
                      },
                    ];
                  }
                });
                `,
            );

            await inputFS.writeFile(
              path.join(inputDir, '.pnp.js'),
              `
                const path = require('path');
                const resolve = request => {
                  if (request === 'parcel-transformer-mock/' || request === 'foo/') {
                    return path.join(__dirname, 'pnp', request);
                  } else if (request === 'pnpapi') {
                    return __filename;
                  } else if (request.startsWith('@parcel/')) {
                    // Use node_modules path for parcel packages so source field is used.
                    return path.join(__dirname, '../../../../../../node_modules/', request);
                  } else if (/^((@[^/]+\\/[^/]+)|[^/]+)\\/?$/.test(request)) {
                    return path.dirname(require.resolve(path.join(request, 'package.json')));
                  } else {
                    return require.resolve(request);
                  }
                };

                module.exports = {resolveToUnqualified: resolve, resolveRequest: resolve};
                `,
            );

            // $FlowFixMe[prop-missing]
            Module.findPnpApi = () =>
              // $FlowFixMe
              require(path.join(inputDir, '.pnp.js'));

            await inputFS.writeFile(
              path.join(inputDir, '.parcelrc'),
              JSON.stringify({
                extends: '@parcel/config-default',
                transformers: {
                  '*.js': ['parcel-transformer-mock'],
                },
              }),
            );
          },
          async update(b) {
            let output = await overlayFS.readFile(
              b.bundleGraph.getBundles()[0].filePath,
              'utf8',
            );
            assert(output.includes('TRANSFORMED CODE'));

            await inputFS.writeFile(
              path.join(inputDir, '.pnp.js'),
              `
                const path = require('path');
                const resolve = request => {
                  if (request === 'parcel-transformer-mock/' || request === 'foo/') {
                    return path.join(__dirname, 'pnp2', request);
                  } else if (request === 'pnpapi') {
                    return __filename;
                  } else if (request.startsWith('@parcel/')) {
                    // Use node_modules path for parcel packages so source field is used.
                    return path.join(__dirname, '../../../../../../node_modules/', request);
                  } else if (/^((@[^/]+\\/[^/]+)|[^/]+)\\/?$/.test(request)) {
                    return path.dirname(require.resolve(path.join(request, 'package.json')));
                  } else {
                    return require.resolve(request);
                  }
                };

                module.exports = {resolveToUnqualified: resolve, resolveRequest: resolve};
                `,
            );

            delete require.cache[path.join(inputDir, '.pnp.js')];
            await sleep(100);
          },
        });

        let output = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('UPDATED'));
      } finally {
        process.versions.pnp = origPnpVersion;
        // $FlowFixMe[prop-missing]
        Module._resolveFilename = origModuleResolveFilename;
        await workerFarm.end();
      }
    });

    describe('esm', function () {
      async function setup() {
        await inputFS.mkdirp(inputDir);
        await inputFS.ncp(path.join(__dirname, '/integration/cache'), inputDir);
        await inputFS.writeFile(
          path.join(inputDir, '.parcelrc'),
          JSON.stringify({
            extends: '@parcel/config-default',
            transformers: {
              '*.js': ['parcel-transformer-esm'],
            },
          }),
        );
      }

      it('should invalidate when updating an ESM parcel transformer plugin', async function () {
        // We cannot invalidate an ESM module in node, so for the test, create a separate worker farm.
        let workerFarm = createWorkerFarm({
          maxConcurrentWorkers: 1,
          useLocalWorker: false,
        });

        let b;
        try {
          b = await testCache({
            inputFS,
            outputFS: inputFS,
            async setup() {
              await setup();
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('TRANSFORMED CODE'));

              let transformerDir = path.join(
                inputDir,
                'node_modules',
                'parcel-transformer-esm',
              );
              await inputFS.writeFile(
                path.join(transformerDir, 'constants.js'),
                'export const message = "UPDATED"',
              );
              await new Promise(resolve => setTimeout(resolve, 20));
              return {
                workerFarm,
              };
            },
          });
        } finally {
          await workerFarm.end();
        }

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('UPDATED'));
      });

      it('should invalidate when updating a CJS dependency in an ESM plugin', async function () {
        let workerFarm = createWorkerFarm({
          maxConcurrentWorkers: 1,
          useLocalWorker: false,
        });

        let b;
        try {
          b = await testCache({
            inputFS,
            outputFS: inputFS,
            async setup() {
              await setup();
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('TRANSFORMED CODE 2'));

              let dir = path.join(inputDir, 'node_modules', 'foo');
              await inputFS.writeFile(
                path.join(dir, 'foo.js'),
                'module.exports = 3',
              );
              await new Promise(resolve => setTimeout(resolve, 20));
              return {
                workerFarm,
              };
            },
          });
        } finally {
          await workerFarm.end();
        }

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('TRANSFORMED CODE 3'));
      });

      it('should invalidate on dynamic imports', async function () {
        let workerFarm = createWorkerFarm({
          maxConcurrentWorkers: 1,
          useLocalWorker: false,
        });

        let b;
        try {
          b = await testCache({
            inputFS,
            outputFS: inputFS,
            async setup() {
              await setup();
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('console.log("a")'));

              let dir = path.join(
                inputDir,
                'node_modules',
                'parcel-transformer-esm',
              );
              await inputFS.writeFile(
                path.join(dir, 'data/a.js'),
                'export const value = "updated";',
              );
              await new Promise(resolve => setTimeout(resolve, 20));
              return {
                workerFarm,
              };
            },
          });
        } finally {
          await workerFarm.end();
        }

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('console.log("updated")'));
      });

      it('should invalidate on startup for non-static imports', async function () {
        let spy = sinon.spy(logger, 'warn');
        let workerFarm = createWorkerFarm({
          maxConcurrentWorkers: 1,
          useLocalWorker: false,
        });

        let b;
        try {
          b = await testCache({
            inputFS,
            outputFS: inputFS,
            async setup() {
              await setup();
              await inputFS.writeFile(
                path.join(
                  inputDir,
                  'node_modules',
                  'parcel-transformer-esm',
                  'dep.cjs',
                ),
                'var dep = "foo";exports.value = require(dep);',
              );
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('TRANSFORMED CODE 2'));
              assert(
                spy.calledWith([
                  {
                    message: md`${path.normalize(
                      'node_modules/parcel-transformer-esm/index.js',
                    )} contains non-statically analyzable dependencies in its module graph. This causes Parcel to invalidate the cache on startup.`,
                    origin: '@parcel/package-manager',
                  },
                ]),
              );

              await inputFS.writeFile(
                path.join(inputDir, 'node_modules', 'foo', 'foo.js'),
                'module.exports = 3',
              );
              await new Promise(resolve => setTimeout(resolve, 20));
              return {
                workerFarm,
              };
            },
          });
        } finally {
          spy.restore();
          await workerFarm.end();
        }

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('TRANSFORMED CODE 3'));
      });
    });

    describe('postcss', function () {
      it('should invalidate when a postcss plugin changes', async function () {
        let b = await testCache(
          {
            entries: ['index.css'],
            async setup() {
              await overlayFS.mkdirp(path.join(inputDir, 'node_modules'));
              await ncp(
                path.join(
                  path.join(
                    __dirname,
                    'integration',
                    'postcss-autoinstall',
                    'postcss-test',
                  ),
                ),
                path.join(inputDir, 'node_modules', 'postcss-test'),
              );
            },
            async update(b) {
              let output = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('background: green'));

              let plugin = path.join(
                inputDir,
                'node_modules',
                'postcss-test',
                'index.js',
              );
              let pluginContents = await overlayFS.readFile(plugin, 'utf8');
              await overlayFS.writeFile(
                plugin,
                pluginContents.replace('green', 'red'),
              );
            },
          },
          'postcss-autoinstall/npm',
        );

        let output = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('background: red'));
      });

      it('should invalidate when a JS postcss config changes', async function () {
        let b = await testCache(
          {
            entries: ['style.css'],
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(inputDir);
              await inputFS.ncp(
                path.join(__dirname, '/integration/postcss-js-config-7'),
                inputDir,
              );
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('background-color: red;'));

              let config = path.join(inputDir, 'postcss.config.js');
              let configContents = await inputFS.readFile(config, 'utf8');
              await inputFS.writeFile(
                config,
                configContents.replace('red', 'green'),
              );
              await sleep(100);
            },
          },
          'postcss-js-config-7',
        );

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('background-color: green'));
      });

      it('should invalidate when a JS postcss config dependency changes', async function () {
        let b = await testCache(
          {
            entries: ['index.css'],
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(path.join(inputDir, 'node_modules'));
              await inputFS.ncp(
                path.join(__dirname, '/integration/postcss-autoinstall/npm'),
                inputDir,
              );
              await inputFS.ncp(
                path.join(
                  path.join(
                    __dirname,
                    'integration',
                    'postcss-autoinstall',
                    'postcss-test',
                  ),
                ),
                path.join(inputDir, 'node_modules', 'postcss-test'),
              );

              await inputFS.rimraf(path.join(inputDir, '.postcssrc'));
              let config = path.join(inputDir, 'postcss.config.js');
              await inputFS.writeFile(
                config,
                'module.exports = { plugins: [require("postcss-test")] };',
              );
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('background: green'));

              let plugin = path.join(
                inputDir,
                'node_modules',
                'postcss-test',
                'index.js',
              );
              let pluginContents = await inputFS.readFile(plugin, 'utf8');
              await inputFS.writeFile(
                plugin,
                pluginContents.replace('green', 'red'),
              );

              await sleep(100);
            },
          },
          'postcss-autoinstall/npm',
        );

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('background: red'));
      });

      it('should invalidate when an ESM postcss config changes', async function () {
        // We cannot invalidate an ESM module in node, so for the test, create a separate worker farm.
        let workerFarm = createWorkerFarm({
          maxConcurrentWorkers: 1,
          useLocalWorker: false,
        });

        let b;
        try {
          b = await testCache(
            {
              entries: ['style.css'],
              inputFS,
              outputFS: inputFS,
              async setup() {
                await inputFS.mkdirp(inputDir);
                await inputFS.ncp(
                  path.join(__dirname, '/integration/postcss-esm-config'),
                  inputDir,
                );
              },
              async update(b) {
                let output = await inputFS.readFile(
                  b.bundleGraph.getBundles()[0].filePath,
                  'utf8',
                );
                assert(output.includes('background-color: red;'));

                let config = path.join(inputDir, 'postcss.config.mjs');
                let configContents = await inputFS.readFile(config, 'utf8');
                await inputFS.writeFile(
                  config,
                  configContents.replace('red', 'green'),
                );
                await sleep(100);
                return {workerFarm};
              },
            },
            'postcss-esm-config',
          );
        } finally {
          await workerFarm.end();
        }

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('background-color: green'));
      });

      it('should invalidate when a JSON postcss config changes', async function () {
        let b = await testCache(
          {
            entries: ['nested/index.css'],
            async update(b) {
              let output = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('background-color: green;'));

              let configContents = await overlayFS.readFile(
                path.join(inputDir, '.postcssrc'),
                'utf8',
              );
              await overlayFS.writeFile(
                path.join(inputDir, '.postcssrc'),
                configContents.replace('green', 'red'),
              );
            },
          },
          'postcss-import',
        );

        let output = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('background-color: red'));
      });

      it('should invalidate when a closer postcss config is added', async function () {
        let b = await testCache(
          {
            entries: ['nested/index.css'],
            async update(b) {
              let output = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('background-color: green;'));

              let configContents = await overlayFS.readFile(
                path.join(inputDir, '.postcssrc'),
                'utf8',
              );
              await overlayFS.writeFile(
                path.join(inputDir, 'nested', '.postcssrc'),
                configContents.replace('green', 'red'),
              );
            },
          },
          'postcss-import',
        );

        let output = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('background-color: red'));
      });
    });

    describe('posthtml', function () {
      it('should invalidate when a posthtml plugin changes', async function () {
        let b = await testCache(
          {
            entries: ['index.html'],
            async setup() {
              await overlayFS.mkdirp(path.join(inputDir, 'node_modules'));
              await ncp(
                path.join(
                  path.join(
                    __dirname,
                    'integration',
                    'posthtml-autoinstall',
                    'posthtml-test',
                  ),
                ),
                path.join(inputDir, 'node_modules', 'posthtml-test'),
              );
            },
            async update(b) {
              let output = await overlayFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('<span id="test">Test</span>'));

              let plugin = path.join(
                inputDir,
                'node_modules',
                'posthtml-test',
                'index.js',
              );
              let pluginContents = await overlayFS.readFile(plugin, 'utf8');
              await overlayFS.writeFile(
                plugin,
                pluginContents.replace('span', 'section'),
              );
            },
          },
          'posthtml-autoinstall',
        );

        let output = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('<section id="test">Test</section>'));
      });

      it('should invalidate when a JS postcss config changes', async function () {
        let b = await testCache(
          {
            entries: ['index.html'],
            inputFS,
            outputFS: inputFS,
            async setup() {
              await inputFS.mkdirp(inputDir);
              await inputFS.ncp(
                path.join(__dirname, '/integration/posthtml'),
                inputDir,
              );

              await inputFS.mkdirp(path.join(inputDir, 'include'));
              await inputFS.writeFile(
                path.join(inputDir, 'include', 'other.html'),
                '<h1>Another great page</h1>',
              );
            },
            async update(b) {
              let output = await inputFS.readFile(
                b.bundleGraph.getBundles()[0].filePath,
                'utf8',
              );
              assert(output.includes('<h1>Other page</h1>'));

              let config = path.join(inputDir, '.posthtmlrc.js');
              let configContents = await inputFS.readFile(config, 'utf8');
              await inputFS.writeFile(
                config,
                configContents.replace('__dirname', '__dirname + "/include"'),
              );
              await sleep(100);
            },
          },
          'posthtml',
        );

        let output = await inputFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(output.includes('<h1>Another great page</h1>'));
      });
    });
  });

  describe('bundling', function () {
    it('should invalidate when switching to a different bundler plugin', async function () {
      let b = await testCache({
        async update(b) {
          assert.equal(b.bundleGraph.getBundles().length, 1);

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              bundler: 'parcel-bundler-test',
            }),
          );
        },
      });

      assert.equal(b.bundleGraph.getBundles().length, 4);
    });

    it('should invalidate when a bundler plugin is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              bundler: 'parcel-bundler-test',
            }),
          );
        },
        async update(b) {
          assert.equal(b.bundleGraph.getBundles().length, 4);
          assert.equal(b.bundleGraph.getBundles()[0].name, 'index.js');

          let bundler = path.join(
            inputDir,
            'node_modules',
            'parcel-bundler-test',
            'index.js',
          );
          await overlayFS.writeFile(
            bundler,
            (
              await overlayFS.readFile(bundler, 'utf8')
            ).replace('Boolean(dependency.isEntry)', 'false'),
          );
        },
      });

      assert.equal(b.bundleGraph.getBundles().length, 4);
      assert(b.bundleGraph.getBundles()[0].name.includes('HASH_REF'));
    });

    it('should invalidate when adding a namer plugin', async function () {
      let b = await testCache({
        async update(b) {
          let bundles = b.bundleGraph.getBundles().map(b => b.name);
          assert.deepEqual(bundles, ['index.js']);

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              namers: ['parcel-namer-test'],
            }),
          );
        },
      });

      let bundles = b.bundleGraph.getBundles();
      assert.deepEqual(
        bundles.map(b => b.name),
        bundles.map(b => `${b.id}.${b.type}`),
      );
    });

    it('should invalidate when a namer plugin is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              namers: ['parcel-namer-test'],
            }),
          );
        },
        async update(b) {
          let bundles = b.bundleGraph.getBundles();
          assert.deepEqual(
            bundles.map(b => b.name),
            bundles.map(b => `${b.id}.${b.type}`),
          );

          let namer = path.join(
            inputDir,
            'node_modules',
            'parcel-namer-test',
            'index.js',
          );
          await overlayFS.writeFile(
            namer,
            (
              await overlayFS.readFile(namer, 'utf8')
            ).replace('bundle.id', 'bundle.id.slice(-8)'),
          );
        },
      });

      let bundles = b.bundleGraph.getBundles();
      assert.deepEqual(
        bundles.map(b => b.name),
        bundles.map(b => `${b.id.slice(-8)}.${b.type}`),
      );
    });

    it('should invalidate when adding a runtime plugin', async function () {
      let b = await testCache({
        async update(b) {
          let res = await run(b.bundleGraph, null, {require: false});
          assert.equal(res.runtime_test, undefined);

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              runtimes: ['parcel-runtime-test'],
            }),
          );
        },
      });

      let res = await run(b.bundleGraph, null, {require: false});
      assert.equal(res.runtime_test, true);
    });

    it('should invalidate when a runtime is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              runtimes: ['parcel-runtime-test'],
            }),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph, null, {require: false});
          assert.equal(res.runtime_test, true);
          assert.equal(res.test_runtime, undefined);

          let namer = path.join(
            inputDir,
            'node_modules',
            'parcel-runtime-test',
            'index.js',
          );
          await overlayFS.writeFile(
            namer,
            (
              await overlayFS.readFile(namer, 'utf8')
            ).replace('runtime_test', 'test_runtime'),
          );
        },
      });

      let res = await run(b.bundleGraph, null, {require: false});
      assert.equal(res.runtime_test, undefined);
      assert.equal(res.test_runtime, true);
    });

    describe('bundler config', function () {
      it('should support adding bundler config', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            mode: 'production',
            async setup() {
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': undefined,
                }),
              );
            },
            async update(b) {
              assertBundles(b.bundleGraph, [
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
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': {
                    minBundleSize: 9000000,
                  },
                }),
              );
            },
          },
          'dynamic-common-large',
        );

        assertBundles(b.bundleGraph, [
          {
            assets: ['a.js', 'common.js', 'lodash.js'],
          },
          {
            assets: ['b.js', 'common.js', 'lodash.js'],
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
        ]);
      });

      it('should support adding bundler config for parallel request limits', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            mode: 'production',
            async setup() {
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': undefined,
                }),
              );
            },
            async update(b) {
              assert.deepEqual(b.bundleGraph.getBundles().length, 7);
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': {
                    maxParallelRequests: 0,
                  },
                }),
              );
            },
          },
          'large-bundlegroup',
        );
        assert.deepEqual(b.bundleGraph.getBundles().length, 5);
      });

      it('should support updating bundler config', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            mode: 'production',
            async setup() {
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': {
                    minBundleSize: 8000,
                  },
                }),
              );
            },
            async update(b) {
              assertBundles(b.bundleGraph, [
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
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': {
                    minBundleSize: 9000000,
                  },
                }),
              );
            },
          },
          'dynamic-common-large',
        );

        assertBundles(b.bundleGraph, [
          {
            assets: ['a.js', 'common.js', 'lodash.js'],
          },
          {
            assets: ['b.js', 'common.js', 'lodash.js'],
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
        ]);
      });

      it('should support removing bundler config', async function () {
        let b = await testCache(
          {
            entries: ['index.js'],
            mode: 'production',
            async setup() {
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': {
                    minBundleSize: 9000000,
                  },
                }),
              );
            },
            async update(b) {
              assertBundles(b.bundleGraph, [
                {
                  assets: ['a.js', 'common.js', 'lodash.js'],
                },
                {
                  assets: ['b.js', 'common.js', 'lodash.js'],
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
              ]);
              let pkgFile = path.join(inputDir, 'package.json');
              let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
              await overlayFS.writeFile(
                pkgFile,
                JSON.stringify({
                  ...pkg,
                  '@parcel/bundler-default': undefined,
                }),
              );
            },
          },
          'dynamic-common-large',
        );
        assertBundles(b.bundleGraph, [
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
      });
    });
  });

  describe('packaging', function () {
    it('should invalidate when switching to a different packager plugin', async function () {
      let b = await testCache({
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.notEqual(res, 'packaged');

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.js': 'parcel-packager-test',
              },
            }),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'packaged');
    });

    it('should invalidate when a packager is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.js': 'parcel-packager-test',
              },
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'packaged');

          let packager = path.join(
            inputDir,
            'node_modules',
            'parcel-packager-test',
            'index.js',
          );
          await overlayFS.writeFile(
            packager,
            (
              await overlayFS.readFile(packager, 'utf8')
            ).replace('packaged', 'updated'),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'updated');
    });

    it('should invalidate when adding packager config', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.js': 'parcel-packager-test',
              },
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'packaged');

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'test');
    });

    it('should invalidate when updating packager config', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.js': 'parcel-packager-test',
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'test');

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'updated'}),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'updated');
    });

    it('should invalidate when removing packager config', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.js': 'parcel-packager-test',
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'test');

          await overlayFS.unlink(path.join(inputDir, '.packagerrc'));
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'packaged');
    });

    it('should invalidate when adding an optimizer plugin', async function () {
      let b = await testCache({
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.notEqual(res, 'optimized');

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': ['parcel-optimizer-test'],
              },
            }),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'optimized');
    });

    it('should invalidate when removing an optimizer plugin', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': ['parcel-optimizer-test'],
              },
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'optimized');

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': [],
              },
            }),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.notEqual(res, 'optimized');
    });

    it('should invalidate when an optimizer is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': ['parcel-optimizer-test'],
              },
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'optimized');

          let optimizer = path.join(
            inputDir,
            'node_modules',
            'parcel-optimizer-test',
            'index.js',
          );
          await overlayFS.writeFile(
            optimizer,
            (
              await overlayFS.readFile(optimizer, 'utf8')
            ).replace('optimized', 'updated'),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'updated');
    });

    it('should invalidate when adding optimizer config', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': ['parcel-optimizer-test'],
              },
            }),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'optimized');

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'test');
    });

    it('should invalidate when updating packager config', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': ['parcel-optimizer-test'],
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'test');

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'updated'}),
          );
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'updated');
    });

    it('should invalidate when removing packager config', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.js': ['parcel-optimizer-test'],
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert.equal(res, 'test');

          await overlayFS.unlink(path.join(inputDir, '.optimizerrc'));
        },
      });

      let res = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.equal(res, 'optimized');
    });

    it('should invalidate when an asset content changes', async function () {
      let b = await testCache({
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 4);

          await overlayFS.writeFile(
            path.join(inputDir, 'node_modules/foo/foo.js'),
            'module.exports = 3',
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 6);
    });

    it('should invalidate when an inline bundle changes', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./entries/a.js");',
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert(res.includes(`let a = 'a'`));

          await overlayFS.writeFile(
            path.join(inputDir, 'src/entries/a.js'),
            `export let a = 'b';`,
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert(res.includes(`let a = 'b'`));
    });

    it('should invalidate when switching to a different packager for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.notEqual(res, 'packaged');

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.txt': 'parcel-packager-test',
              },
            }),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'packaged');
    });

    it('should invalidate when a packager for an inline bundle is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.txt': 'parcel-packager-test',
              },
            }),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'packaged');

          let packager = path.join(
            inputDir,
            'node_modules',
            'parcel-packager-test',
            'index.js',
          );
          await overlayFS.writeFile(
            packager,
            (
              await overlayFS.readFile(packager, 'utf8')
            ).replace('packaged', 'updated'),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'updated');
    });

    it('should invalidate when adding packager config for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.txt': 'parcel-packager-test',
              },
            }),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'packaged');

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'test');
    });

    it('should invalidate when updating packager config for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.txt': 'parcel-packager-test',
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'test');

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'updated'}),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'updated');
    });

    it('should invalidate when removing packager config for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              packagers: {
                '*.txt': 'parcel-packager-test',
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.packagerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'test');

          await overlayFS.unlink(path.join(inputDir, '.packagerrc'));
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'packaged');
    });

    it('should invalidate when adding an optimizer for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.notEqual(res, 'packaged');

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.txt': ['parcel-optimizer-test'],
              },
            }),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'optimized');
    });

    it('should invalidate when an optimizer for an inline bundle is updated', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.txt': ['parcel-optimizer-test'],
              },
            }),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'optimized');

          let optimizer = path.join(
            inputDir,
            'node_modules',
            'parcel-optimizer-test',
            'index.js',
          );
          await overlayFS.writeFile(
            optimizer,
            (
              await overlayFS.readFile(optimizer, 'utf8')
            ).replace('optimized', 'updated'),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'updated');
    });

    it('should invalidate when adding optimizer config for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.txt': ['parcel-optimizer-test'],
              },
            }),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'optimized');

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'test');
    });

    it('should invalidate when updating optimizer config for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.txt': ['parcel-optimizer-test'],
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'test');

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'updated'}),
          );
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'updated');
    });

    it('should invalidate when removing optimizer config for an inline bundle', async function () {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("bundle-text:./test.txt");',
          );

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'test',
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              optimizers: {
                '*.txt': ['parcel-optimizer-test'],
              },
            }),
          );

          await overlayFS.writeFile(
            path.join(inputDir, '.optimizerrc'),
            JSON.stringify({value: 'test'}),
          );
        },
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 'test');

          await overlayFS.unlink(path.join(inputDir, '.optimizerrc'));
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 'optimized');
    });

    it('should invalidate when deleting a dist file', async function () {
      let b = await testCache({
        outputFS: overlayFS,
        async update(b) {
          assert(await overlayFS.exists(path.join(distDir, 'index.js')));
          let res = await run(b.bundleGraph);
          assert.equal(res, 4);

          await overlayFS.unlink(path.join(distDir, 'index.js'));
        },
      });

      assert(await overlayFS.exists(path.join(distDir, 'index.js')));
      let res = await run(b.bundleGraph);
      assert.equal(res, 4);
    });

    it('should invalidate when deleting a source map', async function () {
      await testCache({
        outputFS: overlayFS,
        async update() {
          assert(await overlayFS.exists(path.join(distDir, 'index.js.map')));

          await overlayFS.unlink(path.join(distDir, 'index.js.map'));
        },
      });

      assert(await overlayFS.exists(path.join(distDir, 'index.js.map')));
    });

    it('should invalidate when the dist directory', async function () {
      await testCache({
        outputFS: overlayFS,
        async update() {
          assert(await overlayFS.exists(path.join(distDir, 'index.js')));
          assert(await overlayFS.exists(path.join(distDir, 'index.js.map')));

          await overlayFS.rimraf(distDir);
        },
      });

      assert(await overlayFS.exists(path.join(distDir, 'index.js')));
      assert(await overlayFS.exists(path.join(distDir, 'index.js.map')));
    });

    it('should hit the cache when there are no changes', async function () {
      let b = await testCache({
        async update(b) {
          let res = await run(b.bundleGraph);
          assert.equal(res, 4);
        },
      });

      let res = await run(b.bundleGraph);
      assert.equal(res, 4);
    });

    it('should write bundle graph to cache on bundling error', async function () {
      let overlayFSPackageManager = new NodePackageManager(
        overlayFS,
        __dirname,
      );
      let entries = 'source/index.js';
      let options = {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        packageManager: overlayFSPackageManager,
        shouldDisableCache: false,
        inputFS: overlayFS,
        cacheDir: path.join(__dirname, '.parcel-cache'),
      };

      await fsFixture(overlayFS)`
      source
        foo.js:

          export default 2;
        index.js:
          import('./foo');

          export default 1;
        .parcelrc:
          {
            "extends": "@parcel/config-default",
            "bundler": "./test-bundler.js"
          }
        test-bundler.js:
          import {Bundler} from '@parcel/plugin'
          import DefaultBundler from '@parcel/bundler-default'

          const CONFIG = Symbol.for('parcel-plugin-config');

          export default new Bundler({
            loadConfig({config, options}) {
              return DefaultBundler[CONFIG].loadConfig({config, options});
            },

            bundle({bundleGraph, config}) {
              DefaultBundler[CONFIG].bundle({bundleGraph, config});
            },
            optimize() {throw new Error("Intentionally throw error")},
          });
        yarn.lock:`;
      // $FlowFixMe
      await assert.rejects(() => bundle(entries, options));

      let resolvedOptions = await resolveOptions(
        getParcelOptions(entries, options),
      );

      let bundleGraphCacheKey =
        hashString(
          `${version}:BundleGraph:${
            JSON.stringify(resolvedOptions.entries) ?? ''
          }${resolvedOptions.mode}${
            resolvedOptions.shouldBuildLazily ? 'lazy' : 'eager'
          }`,
        ) + '-BundleGraph';

      assert(
        deserialize(
          await resolvedOptions.cache.getLargeBlob(bundleGraphCacheKey),
        ),
      );
    });

    it('should invalidate when a terser config is modified', async function () {
      let b = await testCache({
        mode: 'production',
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.terserrc'),
            JSON.stringify({
              mangle: false,
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('$parcel$interopDefault'));

          await overlayFS.writeFile(
            path.join(inputDir, '.terserrc'),
            JSON.stringify({
              mangle: true,
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('$parcel$interopDefault'));
    });

    it('should invalidate when an htmlnano config is modified', async function () {
      let b = await testCache({
        mode: 'production',
        entries: ['src/index.html'],
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.htmlnanorc.json'),
            JSON.stringify({
              removeAttributeQuotes: true,
            }),
          );
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('type=module'));

          await overlayFS.writeFile(
            path.join(inputDir, '.htmlnanorc.json'),
            JSON.stringify({
              removeAttributeQuotes: false,
            }),
          );
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('type="module"'));
    });
  });

  describe('compression', function () {
    it('should invaldate when adding a compressor plugin', async function () {
      await testCache({
        async update() {
          let files = await outputFS.readdir(distDir);
          assert.deepEqual(files.sort(), ['index.js', 'index.js.map']);

          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              compressors: {
                '*.js': ['...', '@parcel/compressor-gzip'],
              },
            }),
          );
        },
        mode: 'production',
      });

      let files = await outputFS.readdir(distDir);
      assert.deepEqual(files.sort(), [
        'index.js',
        'index.js.gz',
        'index.js.map',
      ]);
    });

    it('should invalidate when updating a compressor plugin', async function () {
      await testCache({
        async setup() {
          await overlayFS.writeFile(
            path.join(inputDir, '.parcelrc'),
            JSON.stringify({
              extends: '@parcel/config-default',
              compressors: {
                '*.js': ['...', 'parcel-compressor-test'],
              },
            }),
          );
        },
        async update() {
          let files = await outputFS.readdir(distDir);
          assert.deepEqual(files.sort(), [
            'index.js',
            'index.js.abc',
            'index.js.map',
          ]);

          let compressor = path.join(
            inputDir,
            'node_modules',
            'parcel-compressor-test',
            'index.js',
          );
          await overlayFS.writeFile(
            compressor,
            (
              await overlayFS.readFile(compressor, 'utf8')
            ).replace('abc', 'def'),
          );
        },
      });

      let files = await outputFS.readdir(distDir);
      assert.deepEqual(files.sort(), [
        'index.js',
        'index.js.abc',
        'index.js.def',
        'index.js.map',
      ]);
    });
  });

  describe('scope hoisting', function () {
    it('should support adding sideEffects config', function () {});

    it('should support updating sideEffects config', function () {});

    it('should support removing sideEffects config', function () {});

    it('should wrap modules when they become conditional', async function () {
      let b = await testCache(
        {
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
          entries: ['a.js'],
          async setup() {
            let contents = await overlayFS.readFile(
              path.join(inputDir, 'a.js'),
              'utf8',
            );
            await overlayFS.writeFile(
              path.join(inputDir, 'a.js'),
              contents.replace(/if \(b\) \{((?:.|\n)+)\}/, '$1'),
            );
          },
          async update(b) {
            let out = [];
            await run(b.bundleGraph, {
              b: false,
              output(o) {
                out.push(o);
              },
            });

            assert.deepEqual(out, ['a', 'b', 'c', 'd']);

            let contents = await overlayFS.readFile(
              path.join(
                __dirname,
                'integration/scope-hoisting/commonjs/require-conditional/a.js',
              ),
              'utf8',
            );
            await overlayFS.writeFile(path.join(inputDir, 'a.js'), contents);
          },
        },
        'scope-hoisting/commonjs/require-conditional',
      );

      let out = [];
      await run(b.bundleGraph, {
        b: false,
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'd']);
    });
  });

  describe('runtime', () => {
    it('should support updating files added by runtimes', async function () {
      let b = await testCache(async b => {
        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('INITIAL CODE'));
        await overlayFS.writeFile(
          path.join(inputDir, 'dynamic-runtime.js'),
          "module.exports = 'UPDATED CODE'",
        );
      }, 'runtime-update');

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('UPDATED CODE'));
    });
  });

  describe('Query Parameters', () => {
    it('Should create additional assets if multiple query parameter combinations are used', async function () {
      let b = await testCache(
        {
          entries: ['reformat.html'],
          update: async b => {
            let bundles = b.bundleGraph.getBundles();
            let contents = await overlayFS.readFile(
              bundles[0].filePath,
              'utf8',
            );
            assert(contents.includes('.webp" alt="test image">'));
            assert.equal(bundles.length, 2);
            await overlayFS.writeFile(
              path.join(inputDir, 'reformat.html'),
              `<picture>
              <source src="url:./image.jpg?as=webp&width=400" type="image/webp" />
              <source src="url:./image.jpg?as=jpg&width=400" type="image/jpeg" />
              <img src="url:./image.jpg?as=jpg&width=800" alt="test image" />
            </picture>`,
            );
          },
        },
        'image',
      );

      let bundles = b.bundleGraph.getBundles();
      let contents = await overlayFS.readFile(bundles[0].filePath, 'utf8');
      assert(contents.includes('.webp" type="image/webp">'));
      assert(contents.includes('.jpeg" type="image/jpeg">'));
      assert(contents.includes('.jpeg" alt="test image">'));
      assert.equal(bundles.length, 4);
    });
  });

  it('should correctly read additional child assets from cache', async function () {
    await ncp(
      path.join(__dirname, '/integration/postcss-modules-cjs'),
      path.join(inputDir),
    );

    let entries = 'index.js';

    let b = await runBundle(entries, {
      defaultTargetOptions: {
        shouldOptimize: false,
      },
    });
    let result1 = (await run(b.bundleGraph))();

    b = await runBundle(entries, {
      defaultTargetOptions: {
        shouldOptimize: true,
      },
    });
    let result2 = (await run(b.bundleGraph))();

    b = await runBundle(entries, {
      defaultTargetOptions: {
        shouldOptimize: false,
      },
    });
    let result3 = (await run(b.bundleGraph))();

    assert(typeof result1 === 'string' && result1.includes('foo'));
    assert.strictEqual(result1, result2);
    assert.strictEqual(result1, result3);
  });

  it('should correctly read additional child assets from cache 2', async function () {
    await ncp(
      path.join(__dirname, '/integration/postcss-modules-cjs'),
      path.join(inputDir),
    );

    let entries = 'index.js';

    await overlayFS.writeFile(
      path.join(inputDir, 'foo.module.css'),
      `.foo {
  color: red;
}`,
    );

    let b = await runBundle(entries);
    let result1 = (await run(b.bundleGraph))();

    await overlayFS.writeFile(
      path.join(inputDir, 'foo.module.css'),
      `.foo {
  color: blue;
}`,
    );

    b = await runBundle(entries);
    let result2 = (await run(b.bundleGraph))();

    await overlayFS.writeFile(
      path.join(inputDir, 'foo.module.css'),
      `.foo {
  color: red;
}`,
    );

    b = await runBundle(entries);
    let result3 = (await run(b.bundleGraph))();

    assert(typeof result1 === 'string' && result1.includes('foo'));
    assert.strictEqual(result1, result2);
    assert.strictEqual(result1, result3);
  });

  it('should correctly reuse intermediate pipeline results when transforming', async function () {
    await ncp(path.join(__dirname, '/integration/json'), path.join(inputDir));

    let entry = path.join(inputDir, 'index.js');
    let original = await overlayFS.readFile(entry, 'utf8');

    let b = await runBundle(entry);
    let result1 = (await run(b.bundleGraph))();

    await overlayFS.writeFile(
      entry,
      'module.exports = function(){ return 10; }',
    );

    b = await runBundle(entry);
    let result2 = (await run(b.bundleGraph))();

    await overlayFS.writeFile(entry, original);

    b = await runBundle(entry);
    let result3 = (await run(b.bundleGraph))();

    assert.strictEqual(result1, 3);
    assert.strictEqual(result2, 10);
    assert.strictEqual(result3, 3);
  });

  it('properly watches included files even after resaving them without changes', async function () {
    this.timeout(15000);
    let subscription;
    let fixture = path.join(__dirname, '/integration/included-file');
    try {
      let b = bundler(path.join(fixture, 'index.txt'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
      });
      await overlayFS.mkdirp(fixture);
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'a');
      subscription = await b.watch();
      let event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output1 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output1, 'a');

      // Change included file
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'b');
      event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output2 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output2, 'b');

      // Rewrite included file without change
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'b');
      event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output3 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output3, 'b');

      // Change included file
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'c');
      event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output4 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output4, 'c');
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });

  it('properly handles included files even after when changing back to a cached state', async function () {
    this.timeout(15000);
    let subscription;
    let fixture = path.join(__dirname, '/integration/included-file');
    try {
      let b = bundler(path.join(fixture, 'index.txt'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
      });
      await overlayFS.mkdirp(fixture);
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'a');
      subscription = await b.watch();
      let event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output1 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output1, 'a');

      // Change included file
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'b');
      event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output2 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output2, 'b');

      // Change included file back
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'a');
      event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output3 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output3, 'a');
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });

  it('properly watches included files after a transformer error', async function () {
    this.timeout(15000);
    let subscription;
    let fixture = path.join(__dirname, '/integration/included-file');
    try {
      let b = bundler(path.join(fixture, 'index.txt'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
      });
      await overlayFS.mkdirp(fixture);
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'a');
      subscription = await b.watch();
      let event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output1 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output1, 'a');

      // Change included file
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'ERROR');
      event = await getNextBuild(b);
      invariant(event.type === 'buildFailure');
      assert.strictEqual(event.diagnostics[0].message, 'Custom error');

      // Clear transformer error
      await overlayFS.writeFile(path.join(fixture, 'included.txt'), 'b');
      event = await getNextBuild(b);
      invariant(event.type === 'buildSuccess');
      let output3 = await overlayFS.readFile(
        event.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(output3, 'b');
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });

  it('should support moving the project root', async function () {
    // This test relies on the real filesystem because the memory fs doesn't support renames.
    // But renameSync is broken on windows in CI with EPERM errors. Just skip this test for now.
    if (process.platform === 'win32') {
      return;
    }

    let b = await testCache({
      inputFS,
      outputFS: inputFS,
      async setup() {
        await inputFS.mkdirp(inputDir);
        await inputFS.ncp(path.join(__dirname, '/integration/cache'), inputDir);
      },
      update: async b => {
        assert.equal(await run(b.bundleGraph), 4);

        await inputFS.writeFile(
          path.join(inputDir, 'src/nested/test.js'),
          'export default 4',
        );

        fs.renameSync(inputDir, (inputDir += '_2'));
        await sleep(100);
      },
    });

    assert.equal(await run(b.bundleGraph), 6);
  });

  it('supports multiple empty JS assets', async function () {
    // Try to store multiple empty assets using LMDB
    let build = await runBundle(
      path.join(__dirname, 'integration/multiple-empty-js-assets/index.js'),
      {
        inputFS,
        outputFS: inputFS,
      },
    );

    let a = nullthrows(findAsset(build.bundleGraph, 'a.js'));
    let b = nullthrows(findAsset(build.bundleGraph, 'a.js'));
    assert.strictEqual((await a.getBuffer()).length, 0);
    assert.strictEqual((await b.getBuffer()).length, 0);

    let res = await run(build.bundleGraph);
    assert.deepEqual(res, {default: 'foo'});
  });

  it('invalidates correctly when switching from lazy to eager modes', async function () {
    let overlayFSPackageManager = new NodePackageManager(overlayFS, __dirname);
    let entry = 'source/index.js';
    let options = {
      mode: 'production',
      defaultTargetOptions: {
        shouldScopeHoist: false,
      },
      packageManager: overlayFSPackageManager,
      shouldContentHash: false,
      shouldDisableCache: false,
      inputFS: overlayFS,
      cacheDir: path.join(__dirname, '.parcel-cache'),
    };

    await fsFixture(overlayFS)`
    source
      lazy.js:

        export default 'lazy-file';
      index.js:
        import('./lazy');

        export default 'index-file';
    `;

    let lazyBundleGraph = await bundle(entry, {
      ...options,
      shouldBuildLazily: true,
    });
    assert.equal(lazyBundleGraph.getBundles().length, 1);

    let eagerBundleGraph = await bundle(entry, {
      ...options,
      shouldBuildLazily: false,
    });
    assert.equal(eagerBundleGraph.getBundles().length, 2);
  });
});
