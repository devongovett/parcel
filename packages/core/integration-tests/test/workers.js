import assert from 'assert';
import path from 'path';
import {
  assertBundles,
  bundle,
  inputFS,
  outputFS,
  removeDistDirectory,
  run,
  runBundle,
} from '@parcel/test-utils';

describe('parcel', function () {
  beforeEach(async () => {
    await removeDistDirectory();
  });

  it('bundles workers and service workers', async function () {
    let b = await bundle(path.join(__dirname, '/integration/workers/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'common.js',
          'worker-client.js',
          'feature.js',
          'get-worker-url.js',
          'bundle-url.js',
        ],
      },
      {
        assets: ['service-worker.js'],
      },
      {
        assets: ['shared-worker.js'],
      },
      {
        assets: ['worker.js', 'common.js'],
      },
    ]);
  });

  it('bundles a dynamic import in a worker', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-dynamic/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        assets: [
          'worker.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js', 'esmodule-helpers.js'],
      },
    ]);

    let res = await new Promise(resolve => {
      run(b, {
        output: resolve,
      });
    });
    assert.deepEqual(res, {default: 42});
  });

  it('bundles a dynamic import in a worker using legacy browser targets', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-dynamic/index.js'),
      {
        defaultTargetOptions: {
          outputFormat: 'esmodule',
          shouldScopeHoist: true,
          engines: {
            browsers: 'IE 11',
          },
        },
      },
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        assets: [
          'worker.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js'],
      },
    ]);

    let res = await new Promise(resolve => {
      run(b, {
        output: resolve,
      });
    });
    assert.deepEqual(res, {default: 42});
  });

  it('bundles a dynamic import in a nested worker', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-dynamic/index-nested.js'),
    );

    assertBundles(b, [
      {
        name: 'index-nested.js',
        assets: ['index-nested.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        assets: [
          'worker-nested.js',
          'bundle-url.js',
          'get-worker-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: [
          'worker.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js', 'esmodule-helpers.js'],
      },
    ]);

    let res = await new Promise(resolve => {
      run(b, {
        output: resolve,
      });
    });
    assert.deepEqual(res, {default: 42});
  });

  it('bundles dynamic imports in both the page and worker', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-dynamic/index-async.js'),
    );

    assertBundles(b, [
      {
        name: 'index-async.js',
        assets: [
          'index-async.js',
          'bundle-url.js',
          'get-worker-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: [
          'worker.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['async.js', 'esmodule-helpers.js'],
      },
      {
        assets: ['async.js', 'esmodule-helpers.js'],
      },
    ]);

    let res = await new Promise(resolve => {
      run(b, {
        output: resolve,
      });
    });
    assert.deepEqual(res, {default: 42});
  });

  it('should support workers pointing to themselves', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-self/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'get-worker-url.js',
          'workerHelpers.js',
          'esmodule-helpers.js',
        ],
      },
      {
        assets: [
          'workerHelpers.js',
          'bundle-url.js',
          'get-worker-url.js',
          'esmodule-helpers.js',
        ],
      },
    ]);

    await run(b);
  });

  it('bundles workers pointing to themselves with import.meta.url', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-self/import-meta.js'),
    );

    assertBundles(b, [
      {
        assets: [
          'import-meta.js',
          'bundle-url.js',
          'get-worker-url.js',
          'esmodule-helpers.js',
        ],
      },
      {
        assets: [
          'import-meta.js',
          'bundle-url.js',
          'get-worker-url.js',
          'esmodule-helpers.js',
        ],
      },
    ]);

    await run(b);
  });

  it('bundles workers of type module', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/workers-module/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
          shouldScopeHoist: true,
        },
      },
    );
    assertBundles(b, [
      {
        assets: ['dedicated-worker.js'],
      },
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'get-worker-url.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['shared-worker.js'],
      },
      {
        assets: ['index.js'],
      },
    ]);

    let dedicated, shared;
    b.traverseBundles((bundle, ctx, traversal) => {
      let mainEntry = bundle.getMainEntry();
      if (mainEntry && mainEntry.filePath.endsWith('shared-worker.js')) {
        shared = bundle;
      } else if (
        mainEntry &&
        mainEntry.filePath.endsWith('dedicated-worker.js')
      ) {
        dedicated = bundle;
      }
      if (dedicated && shared) traversal.stop();
    });

    assert(dedicated);
    assert(shared);

    let main = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    dedicated = await outputFS.readFile(dedicated.filePath, 'utf8');
    shared = await outputFS.readFile(shared.filePath, 'utf8');
    assert(/new Worker(.*?, {[\n\s]+type: 'module'[\n\s]+})/.test(main));
    assert(/new SharedWorker(.*?, {[\n\s]+type: 'module'[\n\s]+})/.test(main));
  });

  for (let shouldScopeHoist of [true, false]) {
    it(`compiles workers to non modules if ${
      shouldScopeHoist
        ? 'browsers do not support it'
        : 'shouldScopeHoist = false'
    }`, async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/workers-module/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
            shouldScopeHoist,
            engines: {
              browsers: '>= 0.25%',
            },
          },
        },
      );

      assertBundles(b, [
        {
          assets: ['dedicated-worker.js'],
        },
        {
          name: 'index.js',
          assets: [
            'index.js',
            'bundle-url.js',
            'get-worker-url.js',
            'bundle-manifest.js',
          ],
        },
        {
          assets: [
            !shouldScopeHoist && 'esmodule-helpers.js',
            'index.js',
          ].filter(Boolean),
        },
        {
          assets: ['shared-worker.js'],
        },
      ]);

      let dedicated, shared;
      b.traverseBundles((bundle, ctx, traversal) => {
        let mainEntry = bundle.getMainEntry();
        if (mainEntry && mainEntry.filePath.endsWith('shared-worker.js')) {
          shared = bundle;
        } else if (
          mainEntry &&
          mainEntry.filePath.endsWith('dedicated-worker.js')
        ) {
          dedicated = bundle;
        }
        if (dedicated && shared) traversal.stop();
      });

      assert(dedicated);
      assert(shared);

      let main = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      dedicated = await outputFS.readFile(dedicated.filePath, 'utf8');
      shared = await outputFS.readFile(shared.filePath, 'utf8');
      assert(/new Worker([^,]*?)/.test(main));
      assert(/new SharedWorker([^,]*?)/.test(main));
      assert(!/export var foo/.test(dedicated));
      assert(!/export var foo/.test(shared));
    });
  }

  for (let supported of [false, true]) {
    it(`compiles workers to ${
      supported ? '' : 'non '
    }modules when browsers do ${
      supported ? '' : 'not '
    }support it with esmodule parent script`, async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/workers-module/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            engines: {browsers: supported ? 'Chrome 80' : 'Chrome 75'},
            outputFormat: 'esmodule',
            shouldScopeHoist: true,
            shouldOptimize: false,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['dedicated-worker.js'],
        },
        {
          name: 'index.js',
          assets: ['index.js', 'bundle-manifest.js', 'get-worker-url.js'],
        },
        {
          type: 'js',
          assets: ['shared-worker.js'],
        },
        {
          type: 'js',
          assets: ['index.js'],
        },
      ]);

      let dedicated, shared;
      b.traverseBundles((bundle, ctx, traversal) => {
        if (bundle.getMainEntry()?.filePath.endsWith('shared-worker.js')) {
          shared = bundle;
        } else if (
          bundle.getMainEntry()?.filePath.endsWith('dedicated-worker.js')
        ) {
          dedicated = bundle;
        }
        if (dedicated && shared) traversal.stop();
      });

      assert(dedicated);
      assert(shared);

      let main = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(/new Worker([^,]*?)/.test(main));
      assert(/new SharedWorker([^,]*?)/.test(main));

      dedicated = await outputFS.readFile(dedicated.filePath, 'utf8');
      shared = await outputFS.readFile(shared.filePath, 'utf8');
      let importRegex = supported ? /importScripts\s*\(/ : /import\s*("|')/;
      assert(!importRegex.test(dedicated));
      assert(!importRegex.test(shared));
    });
  }

  it('preserves the worker name option', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/workers-module/named.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    let main = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(/new Worker(.*?, {[\n\s]+name: 'worker'[\n\s]+})/.test(main));
    assert(/new SharedWorker(.*?, {[\n\s]+name: 'shared'[\n\s]+})/.test(main));
  });

  it('errors when importing in a worker without type: module', async function () {
    let errored = false;
    try {
      await bundle(
        path.join(__dirname, '/integration/workers-module/error.js'),
        {
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
        },
      );
    } catch (err) {
      errored = true;
      assert.equal(
        err.message,
        'Web workers cannot have imports or exports without the `type: "module"` option.',
      );
      assert.deepEqual(err.diagnostics, [
        {
          message:
            'Web workers cannot have imports or exports without the `type: "module"` option.',
          origin: '@parcel/transformer-js',
          codeFrames: [
            {
              filePath: path.join(
                __dirname,
                '/integration/workers-module/dedicated-worker.js',
              ),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 1,
                    column: 1,
                  },
                  end: {
                    line: 1,
                    column: 22,
                  },
                },
              ],
            },
            {
              filePath: path.join(
                __dirname,
                '/integration/workers-module/error.js',
              ),
              codeHighlights: [
                {
                  message: 'The environment was originally created here',
                  start: {
                    line: 1,
                    column: 20,
                  },
                  end: {
                    line: 1,
                    column: 40,
                  },
                },
              ],
            },
          ],
          hints: [
            "Add {type: 'module'} as a second argument to the Worker constructor.",
          ],
          documentationURL:
            'https://parceljs.org/languages/javascript/#classic-scripts',
        },
      ]);
    }

    assert(errored);
  });

  it('bundles workers with different order', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/workers/index-alternative.js'),
    );

    assertBundles(b, [
      {
        name: 'index-alternative.js',
        assets: [
          'index-alternative.js',
          'common.js',
          'worker-client.js',
          'feature.js',
          'bundle-url.js',
          'get-worker-url.js',
        ],
      },
      {
        assets: ['service-worker.js'],
      },
      {
        assets: ['shared-worker.js'],
      },
      {
        assets: ['worker.js', 'common.js'],
      },
    ]);
  });

  for (let workerType of ['webworker', 'serviceworker']) {
    it(`should error when ${workerType}s use importScripts`, async function () {
      let filePath = path.join(
        __dirname,
        `/integration/worker-import-scripts/index-${workerType}.js`,
      );
      let errored = false;
      try {
        await bundle(filePath);
      } catch (err) {
        errored = true;
        assert.equal(
          err.message,
          'Argument to importScripts() must be a fully qualified URL.',
        );
        assert.deepEqual(err.diagnostics, [
          {
            message:
              'Argument to importScripts() must be a fully qualified URL.',
            origin: '@parcel/transformer-js',
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  `/integration/worker-import-scripts/importScripts.js`,
                ),
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 15,
                    },
                    end: {
                      line: 1,
                      column: 27,
                    },
                  },
                ],
              },
              {
                filePath: path.join(
                  __dirname,
                  `integration/worker-import-scripts/index-${workerType}.js`,
                ),
                codeHighlights: [
                  {
                    message: 'The environment was originally created here',
                    start: {
                      line: 1,
                      column: workerType === 'webworker' ? 20 : 42,
                    },
                    end: {
                      line: 1,
                      column: workerType === 'webworker' ? 37 : 59,
                    },
                  },
                ],
              },
            ],
            hints: [
              'Use a static `import`, or dynamic `import()` instead.',
              "Add {type: 'module'} as a second argument to the " +
                (workerType === 'webworker'
                  ? 'Worker constructor.'
                  : 'navigator.serviceWorker.register() call.'),
            ],
            documentationURL:
              'https://parceljs.org/languages/javascript/#classic-script-workers',
          },
        ]);
      }

      assert(errored);
    });
  }

  it('ignores importScripts when not in a worker context', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/worker-import-scripts/importScripts.js',
      ),
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['importScripts.js'],
      },
    ]);

    let res = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(res.includes(`importScripts('imported.js')`));
  });

  it('ignores importScripts in script workers when not passed a string literal', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/worker-import-scripts/index-variable.js',
      ),
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index-variable.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        type: 'js',
        assets: ['variable.js'],
      },
    ]);

    let res = await outputFS.readFile(b.getBundles()[1].filePath, 'utf8');
    assert(res.includes('importScripts(url)'));
  });

  it('ignores importScripts in script workers a fully qualified URL is provided', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/worker-import-scripts/index-external.js',
      ),
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index-external.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        type: 'js',
        assets: ['external.js'],
      },
    ]);

    let res = await outputFS.readFile(b.getBundles()[1].filePath, 'utf8');
    assert(res.includes(`importScripts('https://unpkg.com/parcel')`));
  });

  it('bundles service workers', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/service-worker/a/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'index.js', 'bundle-url.js'],
      },
      {
        assets: ['worker-nested.js'],
      },
      {
        assets: ['worker-outside.js'],
      },
    ]);
  });

  it('bundles service workers with type: module', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/service-worker/module.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'module.js',
        assets: ['module.js', 'bundle-url.js'],
      },
      {
        assets: ['module-worker.js'],
      },
    ]);

    let bundles = b.getBundles();
    let main = bundles.find(b => !b.env.isWorker());
    let worker = bundles.find(b => b.env.isWorker());
    let mainContents = await outputFS.readFile(main.filePath, 'utf8');
    let workerContents = await outputFS.readFile(worker.filePath, 'utf8');
    assert(/navigator.serviceWorker.register\([^,]+?\)/.test(mainContents));
    assert(!/export /.test(workerContents));
  });

  it('preserves the scope option for service workers', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/service-worker/scope.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'scope.js',
        assets: ['bundle-url.js', 'scope.js'],
      },
      {
        assets: ['module-worker.js'],
      },
    ]);

    let bundles = b.getBundles();
    let main = bundles.find(b => !b.env.isWorker());
    let mainContents = await outputFS.readFile(main.filePath, 'utf8');
    assert(
      /navigator.serviceWorker.register\(.*?, {[\n\s]*scope: 'foo'[\n\s]*}\)/.test(
        mainContents,
      ),
    );
  });

  it('errors when importing in a service worker without type: module', async function () {
    let errored = false;
    try {
      await bundle(
        path.join(__dirname, '/integration/service-worker/error.js'),
        {
          defaultTargetOptions: {
            shouldScopeHoist: true,
          },
        },
      );
    } catch (err) {
      errored = true;
      assert.equal(
        err.message,
        'Service workers cannot have imports or exports without the `type: "module"` option.',
      );
      assert.deepEqual(err.diagnostics, [
        {
          message:
            'Service workers cannot have imports or exports without the `type: "module"` option.',
          origin: '@parcel/transformer-js',
          codeFrames: [
            {
              filePath: path.join(
                __dirname,
                '/integration/service-worker/module-worker.js',
              ),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 1,
                    column: 1,
                  },
                  end: {
                    line: 1,
                    column: 19,
                  },
                },
              ],
            },
            {
              filePath: path.join(
                __dirname,
                'integration/service-worker/error.js',
              ),
              codeHighlights: [
                {
                  message: 'The environment was originally created here',
                  start: {
                    line: 1,
                    column: 42,
                  },
                  end: {
                    line: 1,
                    column: 59,
                  },
                },
              ],
            },
          ],
          hints: [
            "Add {type: 'module'} as a second argument to the navigator.serviceWorker.register() call.",
          ],
          documentationURL:
            'https://parceljs.org/languages/javascript/#classic-scripts',
        },
      ]);
    }

    assert(errored);
  });

  it('exposes a manifest to service workers', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/service-worker/manifest.js'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'manifest.js',
        assets: ['manifest.js', 'bundle-url.js'],
      },
      {
        assets: ['manifest-worker.js', 'service-worker.js'],
      },
    ]);

    let bundles = b.getBundles();
    let worker = bundles.find(b => b.env.isWorker());
    let manifest, version;
    await runBundle(b, worker, {
      output(m, v) {
        manifest = m;
        version = v;
      },
    });
    assert.deepEqual(manifest, ['/manifest.js']);
    assert.equal(typeof version, 'string');
  });

  it('recognizes serviceWorker.register with static URL and import.meta.url', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/service-worker-import-meta-url/index.js',
      ),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js'],
      },
      {
        assets: ['worker.js'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('import.meta.url'));
  });

  it('throws a codeframe for a missing file in serviceWorker.register with URL and import.meta.url', async function () {
    let fixture = path.join(
      __dirname,
      'integration/service-worker-import-meta-url/missing.js',
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
                    column: 55,
                    line: 1,
                  },
                  start: {
                    column: 42,
                    line: 1,
                  },
                },
              ],
            },
          ],
          message: "Failed to resolve './invalid.js' from './missing.js'",
          origin: '@parcel/core',
        },
        {
          hints: ["Did you mean '__./index.js__'?"],
          message: "Cannot load file './invalid.js' in './'.",
          origin: '@parcel/resolver-default',
        },
      ],
    });
  });

  it('errors on dynamic import() inside service workers', async function () {
    let errored = false;
    try {
      await bundle(
        path.join(
          __dirname,
          '/integration/service-worker/dynamic-import-index.js',
        ),
      );
    } catch (err) {
      errored = true;
      assert.equal(err.message, 'import() is not allowed in service workers.');
      assert.deepEqual(err.diagnostics, [
        {
          message: 'import() is not allowed in service workers.',
          origin: '@parcel/transformer-js',
          codeFrames: [
            {
              filePath: path.join(
                __dirname,
                '/integration/service-worker/dynamic-import.js',
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
                    column: 27,
                  },
                },
              ],
            },
            {
              filePath: path.join(
                __dirname,
                'integration/service-worker/dynamic-import-index.js',
              ),
              codeHighlights: [
                {
                  message: 'The environment was originally created here',
                  start: {
                    line: 1,
                    column: 42,
                  },
                  end: {
                    line: 1,
                    column: 60,
                  },
                },
              ],
            },
          ],
          hints: ['Try using a static `import`.'],
        },
      ]);
    }

    assert(errored);
  });

  it('bundles workers with circular dependencies', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-circular/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        assets: ['worker.js', 'worker-dep.js'],
      },
    ]);
  });

  it('recognizes worker constructor with static URL and import.meta.url', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-import-meta-url/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'bundle-url.js', 'get-worker-url.js'],
      },
      {
        assets: ['worker.js'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!contents.includes('import.meta.url'));
  });

  it('ignores worker constructors with dynamic URL and import.meta.url', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-import-meta-url/dynamic.js'),
    );

    assertBundles(b, [
      {
        name: 'dynamic.js',
        assets: ['dynamic.js'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(contents.includes('import.meta.url'));
  });

  it('ignores worker constructors with local URL binding and import.meta.url', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-import-meta-url/local-url.js'),
    );

    assertBundles(b, [
      {
        name: 'local-url.js',
        assets: ['local-url.js'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(contents.includes('import.meta.url'));
  });

  it('throws a codeframe for a missing file in worker constructor with URL and import.meta.url', async function () {
    let fixture = path.join(
      __dirname,
      'integration/worker-import-meta-url/missing.js',
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
                    column: 33,
                    line: 1,
                  },
                  start: {
                    column: 20,
                    line: 1,
                  },
                },
              ],
            },
          ],
          message: "Failed to resolve './invalid.js' from './missing.js'",
          origin: '@parcel/core',
        },
        {
          hints: [
            "Did you mean '__./dynamic.js__'?",
            "Did you mean '__./index.js__'?",
          ],
          message: "Cannot load file './invalid.js' in './'.",
          origin: '@parcel/resolver-default',
        },
      ],
    });
  });

  it.skip('bundles in workers with other loaders', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/workers-with-other-loaders/index.js'),
    );

    assertBundles(b, {
      name: 'index.js',
      assets: [
        'index.js',
        'worker-client.js',
        'cacheLoader.js',
        'js-loader.js',
        'wasm-loader.js',
      ],
      childBundles: [
        {
          type: 'wasm',
          assets: ['add.wasm'],
          childBundles: [],
        },
        {
          type: 'map',
        },
        {
          assets: ['worker.js', 'cacheLoader.js', 'wasm-loader.js'],
          childBundles: [
            {
              type: 'map',
            },
          ],
        },
      ],
    });
  });

  it('creates a shared bundle to deduplicate assets in workers', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-shared/index.js'),
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
          'lodash.js',
          'bundle-url.js',
          'get-worker-url.js',
          'bundle-manifest.js',
          'esmodule-helpers.js',
        ],
      },
      {
        assets: [
          'worker-a.js',
          'bundle-url.js',
          'get-worker-url.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['worker-b.js'],
      },
      {
        assets: ['esmodule-helpers.js', 'lodash.js'],
      },
    ]);

    let sharedBundle = b
      .getBundles()
      .sort((a, b) => b.stats.size - a.stats.size)
      .find(b => b.name !== 'index.js');
    let workerBundle = b.getBundles().find(b => b.name.startsWith('worker-b'));
    let contents = await outputFS.readFile(workerBundle.filePath, 'utf8');
    assert(
      contents.includes(
        `importScripts("./${path.basename(sharedBundle.filePath)}")`,
      ),
    );
  });

  it('creates a shared bundle between browser and worker contexts', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/html-shared-worker/index.html'),
      {mode: 'production', defaultTargetOptions: {shouldScopeHoist: false}},
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        assets: [
          'index.js',
          'get-worker-url.js',
          'lodash.js',
          'esmodule-helpers.js',
          'bundle-manifest.js',
          'bundle-url.js',
        ],
      },
      {
        assets: ['worker.js', 'lodash.js', 'esmodule-helpers.js'],
      },
    ]);

    // let sharedBundle = b
    //   .getBundles()
    //   .sort((a, b) => b.stats.size - a.stats.size)
    //   .find(b => b.name !== 'index.js');
    let workerBundle = b.getBundles().find(b => b.name.startsWith('worker'));
    // let contents = await outputFS.readFile(workerBundle.filePath, 'utf8');
    // assert(
    //   contents.includes(
    //     `importScripts("./${path.basename(sharedBundle.filePath)}")`,
    //   ),
    // );

    let outputArgs = [];
    let workerArgs = [];
    await run(b, {
      Worker: class {
        constructor(url) {
          workerArgs.push(url);
        }
      },
      output: (ctx, val) => {
        outputArgs.push([ctx, val]);
      },
    });

    assert.deepStrictEqual(outputArgs, [['main', 3]]);
    assert.deepStrictEqual(workerArgs, [
      `http://localhost/${path.basename(workerBundle.filePath)}`,
    ]);
  });

  it('supports workers with shared assets between page and worker with async imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-shared-page/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'get-worker-url.js',
          'index.js',
          'js-loader.js',
          'large.js',
        ],
      },
      {
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
          'large.js',
          'worker.js',
        ],
      },
      {
        assets: [
          'bundle-manifest.js',
          'esm-js-loader.js',
          'get-worker-url.js',
          'index.js',
          'large.js',
        ],
      },
      {
        assets: ['async.js'],
      },
      {
        assets: ['async.js'],
      },
      {
        assets: ['async.js'],
      },
    ]);

    await run(b);
  });

  it('async dependency internalization successfully removes unneeded bundlegroups and their bundles', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/internalize-remove-bundlegroup/index.js',
      ),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['bundle-url.js', 'get-worker-url.js', 'index.js'],
      },
      {
        assets: [
          'bundle-url.js',
          'get-worker-url.js',
          'worker1.js',
          'worker2.js',
          'worker3.js',
          'core.js',
        ],
      },
      {assets: ['core.js', 'worker3.js']},
    ]);
  });
});
