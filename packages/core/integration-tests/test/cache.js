// @flow
import type {InitialParcelOptions, BuildSuccessEvent} from '@parcel/types';
import assert from 'assert';
import path from 'path';
import {
  assertBundles,
  bundler,
  run,
  overlayFS,
  inputFS,
  ncp,
  workerFarm,
  mergeParcelOptions,
  sleep,
} from '@parcel/test-utils';
import {md} from '@parcel/diagnostic';
import fs from 'fs';
import {NodePackageManager} from '@parcel/package-manager';

let inputDir: string;
let packageManager = new NodePackageManager(inputFS);

function runBundle(entries = 'src/index.js', opts) {
  entries = (Array.isArray(entries) ? entries : [entries]).map(entry =>
    path.resolve(inputDir, entry),
  );

  return bundler(
    entries,
    mergeParcelOptions(
      {
        inputFS: overlayFS,
        shouldDisableCache: false,
      },
      opts,
    ),
  ).run();
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

  let b = await runBundle(entries, options);

  // update
  let newOptions = await update(b);

  // Run cached build
  b = await runBundle(entries, mergeParcelOptions(options || {}, newOptions));

  return b;
}

describe('cache', function() {
  before(async () => {
    await inputFS.rimraf(path.join(__dirname, 'input'));
  });

  beforeEach(() => {
    inputDir = path.join(
      __dirname,
      '/input',
      Math.random()
        .toString(36)
        .slice(2),
    );
  });

  it('should support updating a JS file', async function() {
    let b = await testCache(async b => {
      assert.equal(await run(b.bundleGraph), 4);
      await overlayFS.writeFile(
        path.join(inputDir, 'src/nested/test.js'),
        'export default 4',
      );
    });

    assert.equal(await run(b.bundleGraph), 6);
  });

  it('should support adding a dependency', async function() {
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

  it('should support adding a dependency which changes the referenced bundles of a parent bundle', async function() {
    async function exec(bundleGraph) {
      let calls = [];
      await run(bundleGraph, {
        call(v) {
          calls.push(v);
        },
      });
      return calls;
    }

    let b = await testCache(
      {
        entries: ['index.html'],
        update: async b => {
          assert.deepEqual(await exec(b.bundleGraph), ['a', 'b']);
          await overlayFS.writeFile(
            path.join(inputDir, 'a.js'),
            'import "./b.js"; call("a");',
          );
        },
      },
      'cache-add-dep-referenced',
    );

    assert.deepEqual(await exec(b.bundleGraph), ['b', 'a']);
  });

  it('should error when deleting a file', async function() {
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

  it('should error when starting parcel from a broken state with no changes', async function() {
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

  describe('babel', function() {
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
      // {name: 'babel.config.mjs', formatter: mjs, nesting: false}
    ];

    let testBabelCache = async (opts: TestConfig) => {
      await workerFarm.callAllWorkers('invalidateRequireCache', [
        packageManager.resolveSync('@parcel/transformer-babel', __filename)
          ?.resolved,
      ]);

      await workerFarm.callAllWorkers('invalidateRequireCache', [
        packageManager.resolveSync('@babel/core', __filename)?.resolved,
      ]);

      return testCache({
        ...opts,
        async update(...args) {
          await opts.update(...args);

          // invalidate babel's caches since we're simulating a process restart
          await workerFarm.callAllWorkers('invalidateRequireCache', [
            packageManager.resolveSync('@parcel/transformer-babel', __filename)
              ?.resolved,
          ]);
          await workerFarm.callAllWorkers('invalidateRequireCache', [
            packageManager.resolveSync('@babel/core', __filename)?.resolved,
          ]);
        },
      });
    };

    for (let {name, formatter, nesting} of configs) {
      describe(name, function() {
        beforeEach(async () => {
          await workerFarm.callAllWorkers('invalidateRequireCache', [
            path.join(inputDir, name),
          ]);
        });

        it(`should support adding a ${name}`, async function() {
          let b = await testBabelCache({
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

        it(`should support updating a ${name}`, async function() {
          let b = await testBabelCache({
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

              await workerFarm.callAllWorkers('invalidateRequireCache', [
                path.join(inputDir, name),
              ]);

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

        it(`should support deleting a ${name}`, async function() {
          let b = await testBabelCache({
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

        it(`should support updating an extended ${name}`, async function() {
          let extendedName = '.babelrc-extended' + path.extname(name);
          let b = await testBabelCache({
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
              await workerFarm.callAllWorkers('invalidateRequireCache', [
                path.join(inputDir, extendedName),
              ]);
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

              await workerFarm.callAllWorkers('invalidateRequireCache', [
                path.join(inputDir, extendedName),
              ]);

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
          it(`should support adding a nested ${name}`, async function() {
            let b = await testBabelCache({
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

          it(`should support updating a nested ${name}`, async function() {
            let b = await testBabelCache({
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
                await workerFarm.callAllWorkers('invalidateRequireCache', [
                  path.join(inputDir, `src/nested/${name}`),
                ]);
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

                await workerFarm.callAllWorkers('invalidateRequireCache', [
                  path.join(inputDir, `src/nested/${name}`),
                ]);

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

          it(`should support deleting a nested ${name}`, async function() {
            let b = await testBabelCache({
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

    describe('.babelignore', function() {
      it('should support adding a .babelignore', async function() {
        let b = await testBabelCache({
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

      it('should support updating a .babelignore', async function() {
        let b = await testBabelCache({
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

      it('should support deleting a .babelignore', async function() {
        let b = await testBabelCache({
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

    describe('plugins', function() {
      it('should invalidate when plugins change versions', async function() {
        let b = await testBabelCache({
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

            await inputFS.writeFile(
              path.join(
                inputDir,
                'node_modules/babel-plugin-dummy/package.json',
              ),
              JSON.stringify({
                name: 'babel-plugin-dummy',
                version: '2.0.0',
              }),
            );

            await workerFarm.callAllWorkers('invalidateRequireCache', [
              path.join(inputDir, 'node_modules/babel-plugin-dummy/index.js'),
            ]);

            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });

      it('should invalidate on startup when there are relative plugins', async function() {
        let b = await testBabelCache({
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

            await workerFarm.callAllWorkers('invalidateRequireCache', [
              path.join(inputDir, 'babel-plugin-dummy.js'),
            ]);

            await sleep(100);
          },
        });

        let contents = await overlayFS.readFile(
          b.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );
        assert(contents.includes('replaced'), 'string should be replaced');
      });

      it('should invalidate on startup when there are symlinked plugins', async function() {
        // Symlinks don't work consistently on windows. Skip this test.
        if (process.platform === 'win32') {
          this.skip();
          return;
        }

        let b = await testBabelCache({
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

            await workerFarm.callAllWorkers('invalidateRequireCache', [
              path.join(inputDir, 'packages/babel-plugin-dummy/index.js'),
            ]);

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

  describe('parcel config', function() {
    it('should support adding a .parcelrc', async function() {
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

    it('should support updating a .parcelrc', async function() {
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

    it('should support updating an extended .parcelrc', async function() {
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

    it('should error when deleting an extended parcelrc', async function() {
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

    it('should support deleting a .parcelrc', async function() {
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

  describe('transformations', function() {
    it('should invalidate when included files changes', async function() {
      let b = await testCache({
        async setup() {
          await overlayFS.writeFile(path.join(inputDir, 'src/test.txt'), 'hi');

          await overlayFS.writeFile(
            path.join(inputDir, 'src/index.js'),
            'module.exports = require("fs").readFileSync(__dirname + "/test.txt", "utf8")',
          );
        },
        async update(b) {
          assert.equal(await run(b.bundleGraph), 'hi');

          await overlayFS.writeFile(
            path.join(inputDir, 'src/test.txt'),
            'updated',
          );
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

    it('should invalidate when environment variables change', async function() {
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
  });

  describe('entries', function() {
    it('should support adding an entry that matches a glob', async function() {
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

    it('should support deleting an entry that matches a glob', async function() {
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

    it('should error when deleting a file entry', async function() {
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

    it('should recover from errors when adding a missing entry', async function() {
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

  describe('target config', function() {
    it('should support adding a target config', async function() {
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
            !contents.includes('export default'),
            'should not include export default',
          );

          let pkgFile = path.join(inputDir, 'package.json');
          let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                esmodule: {
                  outputFormat: 'esmodule',
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
        contents.includes('export default'),
        'should include export default',
      );
    });

    it('should support adding a second target', async function() {
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

    it('should support changing target output location', async function() {
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

    it('should support updating target config options', async function() {
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
            contents.includes('export default'),
            'should include export default',
          );

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

    it('should support deleting a target', async function() {
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

    it('should support deleting all targets', async function() {
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
          assert(
            contents.includes('export default'),
            'should include export default',
          );

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
      assert(
        !contents.includes('export default'),
        'should not include export default',
      );
      assert(
        !contents.includes('module.exports ='),
        'should not include module.exports',
      );
    });

    it('should update when sourcemap options change', async function() {
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

    it('should update when publicUrl changes', async function() {
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
            contents.includes('<script src="http://example.com'),
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
        contents.includes('<script src="http://mygreatwebsite.com'),
        'should include example.com',
      );
    });

    it('should update when a package.json is created', async function() {
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
          assert(
            !contents.includes('export default'),
            'does not include export default',
          );

          await overlayFS.writeFile(
            pkgFile,
            JSON.stringify({
              ...pkg,
              targets: {
                modern: {
                  outputFormat: 'esmodule',
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
        contents.includes('export default'),
        'should include export default',
      );
    });

    it('should update when a package.json is deleted', async function() {
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
            contents.includes('export default'),
            'should include export default',
          );
          await overlayFS.unlink(pkgFile);
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        !contents.includes('export default'),
        'does not include export default',
      );
    });

    describe('browserslist', function() {
      it('should update when a browserslist file is added', async function() {
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

      it('should update when a .browserslistrc file is added', async function() {
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

      it('should update when a browserslist is updated', async function() {
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

      it('should update when a browserslist is deleted', async function() {
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

      it('should update when BROWSERSLIST_ENV changes', async function() {
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

      it('should update when NODE_ENV changes', async function() {
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

  describe('options', function() {
    it('should update when publicUrl changes', async function() {
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
            contents.includes('<script src="http://example.com'),
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
        contents.includes('<script src="http://mygreatwebsite.com'),
        'should include example.com',
      );
    });

    it('should update when minify changes', async function() {
      let b = await testCache({
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
        async update(b) {
          let contents = await overlayFS.readFile(
            b.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes('Test'), 'should include Test');

          return {
            defaultTargetOptions: {
              shouldOptimize: true,
            },
          };
        },
      });

      let contents = await overlayFS.readFile(
        b.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('Test'), 'should not include Test');
    });

    it('should update when scopeHoist changes', async function() {
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

    it('should update when sourceMaps changes', async function() {
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

    it('should update when distDir changes', async function() {
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
              distDir: 'dist/test',
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

    it('should update when targets changes', async function() {
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

    it('should update when defaultEngines changes', async function() {
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

    it('should update when shouldContentHash changes', async function() {
      let b = await testCache({
        entries: ['src/index.html'],
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
        shouldContentHash: true,
        update(b) {
          let bundle = b.bundleGraph.getBundles()[1];
          assert(!bundle.name.includes(bundle.id.slice(-8)));

          return {
            shouldContentHash: false,
          };
        },
      });

      let bundle = b.bundleGraph.getBundles()[1];
      assert(bundle.name.includes(bundle.id.slice(-8)));
    });

    it('should update when hot options change', async function() {
      let b = await testCache({
        hmrOptions: {
          host: 'localhost',
          port: 4321,
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

    it('should invalidate react refresh hot options change', async function() {
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

    it('should update when the config option changes', async function() {
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

    it('should update when the defaultConfig option changes', async function() {
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

    it('should update env browserslist in package.json when mode changes', async function() {
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

  describe('resolver', function() {
    it('should support updating a package.json#main field', async function() {
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

    it('should support adding an alias', async function() {
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

    it('should support updating an alias', async function() {
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

    it('should support deleting an alias', async function() {
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

    it('should support adding an alias in a closer package.json', async function() {
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

    it('should support adding a file with a higher priority extension', async function() {
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

    it('should support renaming a file to a different extension', async function() {
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

    it('should resolve to a file over a directory with an index.js', async function() {
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

    it('should resolve to package.json#main over an index.js', async function() {
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

    it('should recover from errors when adding a missing dependency', async function() {
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

    it('should recover from a missing package.json#main', async function() {
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

    it('should recover from an invalid package.json', async function() {
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

    it('should support adding a deeper node_modules folder', async function() {
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

    describe('pnp', function() {
      it('should invalidate when the .pnp.js file changes', async function() {
        // $FlowFixMe
        let Module = require('module');
        let origPnpVersion = process.versions.pnp;
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

                // $FlowFixMe
                process.versions.pnp = 42;

                Module.findPnpApi = () =>
                  // $FlowFixMe
                  require(path.join(inputDir, '.pnp.js'));

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
          process.versions.pnp = origPnpVersion;
          Module._resolveFilename = origModuleResolveFilename;
        }
      });
    });

    describe('stylus', function() {
      it('should support resolver inside stylus file', async function() {
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
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(css.includes('.a {'));
        assert(!css.includes('.b {'));
        assert(css.includes('.c {'));
      });

      it('should support stylus default resolver', async function() {
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
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(!css.includes('.a {'));
        assert(css.includes('.b {'));
      });

      it('should support glob imports in stylus files', async function() {
        let b = await testCache(
          {
            entries: ['index.js'],
            async update(b) {
              let css = await overlayFS.readFile(
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(css.includes('.index'));
        assert(css.includes('.main'));
        assert(css.includes('.foo'));
        assert(css.includes('.bar'));
        assert(css.includes('.test'));
        assert(css.includes('.foo-test'));
      });

      it('should support glob imports under stylus paths', async function() {
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
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
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

    describe('less', function() {
      it('should support adding higher priority less include paths', async function() {
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
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(!css.includes('.a'));
        assert(!css.includes('.b'));
        assert(css.includes('.c'));
        assert(css.includes('.d'));
      });

      it('should recover from missing import errors', async function() {
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(css.includes('.d'));
        assert(css.includes('.b'));
      });
    });

    describe('sass', function() {
      it('should support adding higher priority sass include paths', async function() {
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
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(!css.includes('.included'));
        assert(css.includes('.test'));
      });

      it('should the SASS_PATH environment variable', async function() {
        let b = await testCache(
          {
            entries: ['index.sass'],
            env: {
              SASS_PATH: path.join(inputDir, 'include-path'),
            },
            async setup() {
              await overlayFS.mkdirp(path.join(inputDir, 'include2'));
              await overlayFS.writeFile(
                path.join(inputDir, 'include2/style.sass'),
                `.test
                  background: blue
                `,
              );
            },
            async update(b) {
              let css = await overlayFS.readFile(
                b.bundleGraph.getBundles().find(b => b.type === 'css')
                  ?.filePath,
                'utf8',
              );
              assert(css.includes('.included'));

              return {
                env: {
                  SASS_PATH: path.join(inputDir, 'include2'),
                },
              };
            },
          },
          'sass-include-paths-import',
        );

        let css = await overlayFS.readFile(
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(!css.includes('.included'));
        assert(css.includes('.test'));
      });

      it('should recover from missing import errors', async function() {
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
          b.bundleGraph.getBundles().find(b => b.type === 'css')?.filePath,
          'utf8',
        );
        assert(css.includes('.d'));
      });
    });
  });

  describe('bundler config', function() {
    it('should support adding bundler config', function() {});

    it('should support updating bundler config', function() {});

    it('should support removing bundler config', function() {});
  });

  describe('scope hoisting', function() {
    it('should support adding sideEffects config', function() {});

    it('should support updating sideEffects config', function() {});

    it('should support removing sideEffects config', function() {});
  });

  describe('runtime', () => {
    it('should support updating files added by runtimes', async function() {
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
    it('Should create additional assets if multiple query parameter combinations are used', async function() {
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
      assert(contents.includes('.jpg" type="image/jpeg">'));
      assert(contents.includes('.jpg" alt="test image">'));
      assert.equal(bundles.length, 4);
    });
  });

  it('should correctly read additional child assets from cache', async function() {
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

  it('should correctly read additional child assets from cache 2', async function() {
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

  it('should correctly reuse intermediate pipeline results when transforming', async function() {
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
});
