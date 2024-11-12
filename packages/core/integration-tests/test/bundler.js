import path from 'path';
import assert from 'assert';
import Logger from '@parcel/logger';
import {
  assertBundles,
  bundle,
  findAsset,
  overlayFS,
  fsFixture,
  run,
} from '@parcel/test-utils';
import {hashString} from '@parcel/rust';
import {normalizePath} from '@parcel/utils';

describe('bundler', function () {
  it('should not create shared bundles when a bundle is being reused and disableSharedBundles is enabled', async function () {
    await fsFixture(overlayFS, __dirname)`
      disable-shared-bundle-single-source
        a.js:
          import foo from './foo';

          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundles": 0,
              "minBundleSize": 200,
              "maxParallelRequests": 100,
              "disableSharedBundles": true
            }
          }

        yarn.lock:`;

    let b = await bundle(
      path.join(__dirname, 'disable-shared-bundle-single-source/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
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
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['a.js', 'b.js', 'foo.js', 'bar.js'],
      },
    ]);
  });

  it('should not create shared bundles and should warn when disableSharedBundles is set to true with maxParallelRequests set', async function () {
    await fsFixture(overlayFS, __dirname)`
      disable-shared-bundles-true-parallel
        a.js:
          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "maxParallelRequests": 100,
              "disableSharedBundles": true
            }
          }

        yarn.lock:`;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });
    let b = await bundle(
      path.join(__dirname, 'disable-shared-bundles-true-parallel/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
    );
    loggerDisposable.dispose();

    assert.deepEqual(messages, [
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/bundler-default',
            message:
              'The value of "100" set for maxParallelRequests will not be used as shared bundles have been disabled',
          },
        ],
      },
    ]);
    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['bar.js', 'a.js', 'b.js'],
      },
    ]);
  });

  it('should not create shared bundles and should warn when disableSharedBundles is set to true with minBundleSize set', async function () {
    await fsFixture(overlayFS, __dirname)`
      disable-shared-bundles-true-min-bundleSize
        a.js:
          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundleSize": 200,
              "disableSharedBundles": true
            }
          }

        yarn.lock:`;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });
    let b = await bundle(
      path.join(
        __dirname,
        'disable-shared-bundles-true-min-bundleSize/index.js',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
    );
    loggerDisposable.dispose();

    assert.deepEqual(messages, [
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/bundler-default',
            message:
              'The value of "200" set for minBundleSize will not be used as shared bundles have been disabled',
          },
        ],
      },
    ]);
    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['bar.js', 'a.js', 'b.js'],
      },
    ]);
  });

  it('should not create shared bundles and should warn when disableSharedBundles is set to true with minBundles set', async function () {
    await fsFixture(overlayFS, __dirname)`
      disable-shared-bundles-true-min-bundles
        a.js:
          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundles": 0,
              "disableSharedBundles": true
            }
          }

        yarn.lock:`;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });
    let b = await bundle(
      path.join(__dirname, 'disable-shared-bundles-true-min-bundles/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
    );
    loggerDisposable.dispose();

    assert.deepEqual(messages, [
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/bundler-default',
            message:
              'The value of "0" set for minBundles will not be used as shared bundles have been disabled',
          },
        ],
      },
    ]);
    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['bar.js', 'a.js', 'b.js'],
      },
    ]);
  });

  it('should not create shared bundles and should warn when disableSharedBundles is set to true with minBundles, minBundleSize and maxParallelRequests set', async function () {
    await fsFixture(overlayFS, __dirname)`
      disable-shared-bundles-true-min-bundles-parallel
        a.js:
          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundles": 0,
              "minBundleSize": 200,
              "maxParallelRequests": 100,
              "disableSharedBundles": true
            }
          }

        yarn.lock:`;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });
    let b = await bundle(
      path.join(
        __dirname,
        'disable-shared-bundles-true-min-bundles-parallel/index.js',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
    );
    loggerDisposable.dispose();

    assert.deepEqual(messages, [
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/bundler-default',
            message:
              'The value of "0" set for minBundles will not be used as shared bundles have been disabled',
          },
        ],
      },
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/bundler-default',
            message:
              'The value of "200" set for minBundleSize will not be used as shared bundles have been disabled',
          },
        ],
      },
      {
        type: 'log',
        level: 'warn',
        diagnostics: [
          {
            origin: '@parcel/bundler-default',
            message:
              'The value of "100" set for maxParallelRequests will not be used as shared bundles have been disabled',
          },
        ],
      },
    ]);
    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['bar.js', 'a.js', 'b.js'],
      },
    ]);
  });

  it('should create shared bundles and should not throw a warning when disableSharedBundles is set to false', async function () {
    await fsFixture(overlayFS, __dirname)`
      disable-shared-bundles-false
        a.js:
          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundles": 0,
              "minBundleSize": 200,
              "maxParallelRequests": 100,
              "disableSharedBundles": false
            }
          }

        yarn.lock:`;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });
    let b = await bundle(
      path.join(__dirname, 'disable-shared-bundles-false/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
    );
    loggerDisposable.dispose();

    assert.deepEqual(messages, []);
    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-url.js',
          'cacheLoader.js',
          'esmodule-helpers.js',
          'js-loader.js',
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js'],
      },
      {
        assets: ['bar.js'],
      },
      {
        assets: ['a.js', 'b.js'],
      },
    ]);
  });

  it('should not count inline assests towards parallel request limit', async function () {
    await fsFixture(overlayFS, __dirname)`
      inlined-assests
        buzz.js:
          export default 7;
        inline-module.js:
          import('./buzz');

          export default 10;
        local.html:
          <!doctype html>
          <html>
            <body>
              <script type="module">
                import './inline-module';
              </script>
            </body>
          </html>

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundles": 1,
              "minBundleSize": 200,
              "maxParallelRequests": 2
            }
          }

        yarn.lock:`;

    // Shared bundle should not be removed in this case
    let b = await bundle(path.join(__dirname, 'inlined-assests/local.html'), {
      mode: 'production',
      defaultTargetOptions: {
        shouldScopeHoist: false,
      },
      inputFS: overlayFS,
    });

    assertBundles(b, [
      {
        assets: ['local.html'],
      },
      {
        assets: ['buzz.js'],
      },
      {
        assets: [
          'inline-module.js',
          'local.html',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {
        assets: ['esmodule-helpers.js'],
      },
    ]);
  });

  it('should not create a shared bundle from an asset if that asset is shared by less than minBundles bundles', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/min-bundles/index.js'),
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
        // a and b are shared between only 2 bundles so they are kept in each bundle
        assets: ['bar.js', 'a.js', 'b.js'],
      },
      {
        assets: ['buzz.js'],
      },
      {
        assets: ['a.js', 'b.js', 'foo.js'],
      },
      {
        // c is shared between 3 different bundles, so it stays
        assets: ['c.js'],
      },
      {
        assets: ['styles.css'],
      },
      {
        assets: ['local.html'],
      },
    ]);
  });

  it('should remove reused bundle (over shared bundles based on size) if the bundlegroup hit the parallel request limit', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/shared-bundle-reused-bundle-remove-reuse/index.js',
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
        assets: ['bar.js', 'foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['buzz.js'],
      },
      {
        assets: ['c.js'],
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

  //This test case is the same as previous except we remove the shared bundle since it is smaller
  it('should remove shared bundle (over reused bundles based on size) if the bundlegroup hit the parallel request limit', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/shared-bundle-reused-bundle-remove-shared/index.js',
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
        assets: ['bar.js', 'c.js'],
      },
      {
        // A consequence of our shared bundle 'c'  being removed for the bundleGroup bar
        // is that it must also be removed for buzz, even though the buzz bundleGroup does not
        // hit the parallel request limit. This is because the shared bundle is no longer sharing
        // it is only attached to one bundle and thus should be removed.
        assets: ['buzz.js', 'c.js'],
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

  it('should not remove shared bundle from graph if one bundlegroup hits the parallel request limit, and at least 2 other bundleGroups that need it do not', async function () {
    //The shared bundle should only be 'put back' for the bundlegroups which hit the parallel request limit
    // But if there are at least two other bundlegroups using this shared bundle that do not hit the max limit
    // the shared bundle should not be removed from the graph
    let b = await bundle(
      path.join(
        __dirname,
        'integration/shared-bundle-remove-from-one-group-only/index.js',
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
        assets: ['bar.js', 'c.js'], // shared bundle merged back
      },
      {
        assets: ['buzz.js'],
      },
      {
        assets: ['c.js'], // shared bundle
      },
      {
        assets: ['foo.js'],
      },
      {
        assets: ['styles.css'],
      },
      {
        assets: ['local.html'],
      },
    ]);
  });

  it('should not remove shared bundle from graph if its parent (a reused bundle) is removed by parallel request limit', async function () {
    //The shared bundle should only be 'put back' for the bundlegroups which hit the parallel request limit
    // But if there are at least two other bundlegroups using this shared bundle that do not hit the max limit
    // the shared bundle should not be removed from the graph
    let b = await bundle(
      path.join(
        __dirname,
        'integration/shared-bundle-between-reused-bundle-removal/index.js',
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
        assets: ['bar.js', 'foo.js', 'a.js', 'b.js'], // shared bundle merged back
      },
      {
        assets: ['buzz.js'],
      },
      {
        assets: ['c.js'], // shared bundle
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['styles.css'],
      },
      {
        assets: ['local.html'],
      },
    ]);

    assert(
      b
        .getReferencedBundles(b.getBundlesWithAsset(findAsset(b, 'bar.js'))[0])
        .includes(b.getBundlesWithAsset(findAsset(b, 'c.js'))[0]),
    );
  });

  it('should respect mode specific config', async function () {
    await fsFixture(overlayFS, __dirname)`
      mode-specific-bundler-config
        a.js:
          import foo from './foo';

          export default 5;
        b.js:
          export default 4;
        bar.js:
          import a from './a';
          import b from './b';

          export default 3;
        foo.js:
          import a from './a';
          import b from './b';

          export default 2;
        index.js:
          import('./foo');
          import('./bar');

          export default 1;

        package.json:
          {
            "@parcel/bundler-default": {
              "minBundles": 0,
              "minBundleSize": 200,
              "production": {
                "maxParallelRequests": 100,
                "disableSharedBundles": true
              }
            }
          }

        yarn.lock:`;

    let b = await bundle(
      path.join(__dirname, 'mode-specific-bundler-config/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
        },
        inputFS: overlayFS,
      },
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
          'bundle-manifest.js',
        ],
      },
      {
        assets: ['foo.js', 'a.js', 'b.js'],
      },
      {
        assets: ['a.js', 'b.js', 'foo.js', 'bar.js'],
      },
    ]);
  });

  it('should support inline constants', async () => {
    await fsFixture(overlayFS, __dirname)`
      inline-constants-shared-bundles
        one.html:
          <script type="module" src="./one.js" />

        two.html:
          <script type="module" src="./two.js" />

        one.js:
          import {sharedFn} from './shared';
          import {constant} from './constants';
          sideEffectNoop('one' + sharedFn() + constant);

        two.js:
          import {sharedFn} from './shared';

          sideEffectNoop('two' + sharedFn);

        shared.js:
          import {constant} from './constants.js';

          export function sharedFn() {
            return constant;
          }

        constants.js:
          export const constant = 'constant';

        package.json:
          {
            "@parcel/transformer-js": {
              "unstable_inlineConstants": true
            },
            "@parcel/bundler-default": {
              "minBundleSize": 0,
              "minBundles": 3
            }
          }

        yarn.lock:`;

    let b = await bundle(
      [
        path.join(__dirname, 'inline-constants-shared-bundles', 'one.html'),
        path.join(__dirname, 'inline-constants-shared-bundles', 'two.html'),
      ],
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      },
    );

    assertBundles(b, [
      {
        assets: ['one.html'],
      },
      {
        assets: ['two.html'],
      },
      {
        assets: ['one.js', 'shared.js', 'constants.js'],
      },
      {
        assets: ['two.js', 'shared.js', 'constants.js'],
      },
    ]);
  });

  it('should support inline constants with shared bundles', async () => {
    await fsFixture(overlayFS, __dirname)`
      inline-constants-shared-bundles
        one.html:
          <script type="module" src="./one.js" />

        two.html:
          <script type="module" src="./two.js" />

        one.js:
          import {sharedFn} from './shared';
          import {constant} from './constants';
          sideEffectNoop('one' + sharedFn() + constant);

        two.js:
          import {sharedFn} from './shared';

          sideEffectNoop('two' + sharedFn);

        shared.js:
          import {constant} from './constants.js';

          export function sharedFn() {
            return constant;
          }

        constants.js:
          export const constant = 'constant';

        package.json:
          {
            "@parcel/transformer-js": {
              "unstable_inlineConstants": true
            },
            "@parcel/bundler-default": {
              "minBundleSize": 0
            }
          }

        yarn.lock:`;

    let b = await bundle(
      [
        path.join(__dirname, 'inline-constants-shared-bundles', 'one.html'),
        path.join(__dirname, 'inline-constants-shared-bundles', 'two.html'),
      ],
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      },
    );

    assertBundles(b, [
      {
        assets: ['one.html'],
      },
      {
        assets: ['two.html'],
      },
      {
        assets: ['one.js', 'constants.js'],
      },
      {
        assets: ['two.js'],
      },
      {
        // shared bundle
        assets: ['shared.js', 'constants.js'],
      },
    ]);
  });

  it('should support inline constants in non-splittable bundles', async () => {
    await fsFixture(overlayFS, __dirname)`
      inline-constants-non-splittable
        index.js:
          import {sharedFn} from './shared';
          sideEffectNoop(sharedFn());

        shared.js:
          import {constant} from './constants';

          export function sharedFn() {
            return constant;
          }

        constants.js:
          export const constant = 'constant';

        package.json:
          {
            "@parcel/transformer-js": {
              "unstable_inlineConstants": true
            }
          }

        yarn.lock:`;

    let b = await bundle(
      path.join(__dirname, 'inline-constants-non-splittable/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      },
    );

    assertBundles(b, [
      {
        assets: ['index.js', 'shared.js', 'constants.js'],
      },
    ]);
  });

  it('should support inline constants in async bundles', async () => {
    await fsFixture(overlayFS, __dirname)`
    inline-constants-async
      index.js:
        import('./async').then(m => console.log(m.value));

      async.js:
        export const value = 'async value';

      package.json:
        {
          "@parcel/transformer-js": {
            "unstable_inlineConstants": true
          }
        }

      yarn.lock:`;

    let b = await bundle(
      path.join(__dirname, 'inline-constants-async/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      },
    );

    // This will fail when the async bundle does not export it's constant
    await run(b);

    // Asset should not be inlined
    const index = b.getBundles().find(b => b.name.startsWith('index'));
    const contents = overlayFS.readFileSync(index.filePath, 'utf8');
    assert(
      !contents.includes('async value'),
      'async value should not be inlined',
    );
  });
  describe('manual shared bundles', () => {
    const dir = path.join(__dirname, 'manual-bundle');

    beforeEach(() => {
      overlayFS.mkdirp(dir);
    });

    afterEach(() => {
      overlayFS.rimraf(dir);
    });

    it('should support manual shared bundles via glob config option for different types', async function () {
      await fsFixture(overlayFS, dir)`
      yarn.lock:
        // Required for config loading
      package.json:
        {
          "@parcel/bundler-default": {
            "minBundleSize": 0,
            "manualSharedBundles": [{
              "name": "vendor",
              "assets": ["vendor*.*"]
            }]
          }
        }

      index.html:
        <script type="module" src="./index.js"></script>

      index.js:
        import './vendor.css';
        import './vendor.js';
        import('./async');

      async.js:
        import './vendor-async.css';
        import './vendor-async.js';

      vendor.js:
        export default 'vendor.js';

      vendor-async.js:
        export default 'vendor-async.js';

      vendor.css:
        body {
          background: blue;
        }

      vendor-async.css:
        body {
          color: blue;
        }
        `;

      let b = await bundle(path.join(dir, 'index.html'), {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          assets: [
            'bundle-manifest.js',
            'bundle-url.js',
            'cacheLoader.js',
            'css-loader.js',
            'esmodule-helpers.js',
            'index.js',
            'js-loader.js',
          ],
        },
        {
          assets: ['async.js'],
        },
        {
          // Vendor MSB for CSS
          assets: ['vendor.css', 'vendor-async.css'],
        },
        {
          // Vendor MSB for JS
          assets: ['vendor.js', 'vendor-async.js'],
        },
      ]);
    });

    it('should respect Asset.isBundleSplittable', async function () {
      await fsFixture(overlayFS, dir)`
      yarn.lock:
        // Required for config loading
      package.json:
        {
          "@parcel/bundler-default": {
            "manualSharedBundles": [{
              "name": "manual-inline",
              "assets": ["shared.js"]
            }]
          }
        }

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "transformers": {
            "*.js": ["./transformer.js", "..."],
          }
        }

      transformer.js:
        import { Transformer } from '@parcel/plugin';

        export default new Transformer({
          transform({asset}) {
            if (asset.filePath.endsWith('.html')) {
              asset.isBundleSplittable = false;
            }

            return [asset];
          }
        });

      index.html:
        <script type="module">
          import shared from './shared.js';
          sideEffectNoop(shared);
        </script>
        <script type="module" src="./index.js"></script>

      index.js:
        import shared from './shared.js';
        sideEffectNoop(shared);

      shared.js:
        export default 'shared';
      `;

      let b = await bundle(path.join(dir, 'index.html'), {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          // Inline script bundle
          assets: ['index.html', 'esmodule-helpers.js', 'shared.js'],
        },
        {
          assets: ['esmodule-helpers.js', 'index.js'],
        },
        {
          // MSB for JS
          assets: ['shared.js'],
        },
      ]);

      run(b);
    });

    it('should support manual shared bundles via glob config option for configured types', async function () {
      await fsFixture(overlayFS, dir)`
      yarn.lock:
        // Required for config loading
      package.json:
        {
          "@parcel/bundler-default": {
            "minBundleSize": 0,
            "manualSharedBundles": [{
              "name": "vendor",
              "assets": ["vendor*.*"],
              "types": ["js"]
            }]
          }
        }

      index.html:
        <script type="module" src="./index.js"></script>

      index.js:
        import './vendor.css';
        import './vendor.js';
        import('./async');

      async.js:
        import './vendor-async.css';
        import './vendor-async.js';

      vendor.js:
        export default 'vendor.js';

      vendor-async.js:
        export default 'vendor-async.js';

      vendor.css:
        body {
          background: blue;
        }

      vendor-async.css:
        body {
          color: blue;
        }
        `;

      let b = await bundle(path.join(dir, 'index.html'), {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          sourceMaps: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          assets: [
            'bundle-manifest.js',
            'bundle-url.js',
            'cacheLoader.js',
            'css-loader.js',
            'esmodule-helpers.js',
            'index.js',
            'js-loader.js',
          ],
        },
        {
          assets: ['async.js'],
        },
        {
          assets: ['vendor.css'],
        },
        {
          assets: ['vendor-async.css'],
        },
        {
          // Vendor MSB for JS
          assets: ['vendor.js', 'vendor-async.js'],
        },
      ]);
    });

    it('should support manual shared bundles via parent config option', async function () {
      await fsFixture(overlayFS, dir)`
      yarn.lock:
        // Required for config loading
      package.json:
        {
          "@parcel/bundler-default": {
            "minBundleSize": 0,
            "manualSharedBundles": [{
              "name": "vendor",
              "root": "math/math.js",
              "assets": ["math/!(divide).js"]
            }]
          }
        }

      index.html:
        <script type="module" src="./index.js"></script>

      index.js:
        import {add, subtract, divide} from './math/math';
        sideEffectNoop(divide(subtract(add(1, 2), 3), 4));

      math
        math.js:
          export * from './add';
          export * from './subtract';
          export * from './divide';

        add.js:
          export const add = (a, b) => a + b;

        subtract.js:
          export const subtract = (a, b) => a - b;

        divide.js:
          export const divide = (a, b) => a / b;
      `;

      let b = await bundle(path.join(dir, 'index.html'), {
        defaultTargetOptions: {
          shouldScopeHoist: false,
          sourceMaps: false,
        },
        inputFS: overlayFS,
      });
      //assert that a,b,c are in one bundle, causeing foo and bar to overfetch, due to MSB config
      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          assets: ['esmodule-helpers.js', 'index.js', 'divide.js'],
        },
        {
          // Manual shared bundle
          assets: ['math.js', 'add.js', 'subtract.js'],
        },
      ]);

      let targetDistDir = normalizePath(path.join(__dirname, '../dist'));
      let hashedIdWithMSB = hashString('bundle:' + 'vendor,js' + targetDistDir);
      assert(
        b.getBundles().find(b => b.id == hashedIdWithMSB),
        'MSB id does not match expected',
      );
    });

    it('should support manual shared bundles with constants module', async function () {
      await fsFixture(overlayFS, dir)`
      yarn.lock:
        // Required for config loading
      package.json:
        {
          "@parcel/transformer-js" : {
            "unstable_inlineConstants": true
          },
          "@parcel/bundler-default": {
            "minBundleSize": 0,
            "manualSharedBundles": [{
              "name": "vendor",
              "assets": ["vendor*.*"],
              "types": ["js"]
            }]
          },
          "sideEffects": ["index.js"]
        }

      vendor-constants.js:
        export const a = 'hello';

      index.html:
        <script type="module" src="./index.js"></script>

      index.js:
        import {a} from './vendor-constants.js';
        import('./async').then((res) => sideEffectNoop(res));
        sideEffectNoop(a);

      async.js:
        import v from './vendor-async.js';
        export default 'async' + v;

      vendor-async.js:
        import {a} from './vendor-constants.js';
        export default 'vendor-async.js' + a;
        `;

      let b = await bundle(path.join(dir, 'index.html'), {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          assets: [
            'bundle-manifest.js',
            'esm-js-loader.js',
            'index.js',
            'vendor-constants.js',
          ],
        },
        {
          assets: ['async.js'],
        },
        {
          // Vendor MSB for JS
          assets: ['vendor-async.js', 'vendor-constants.js'],
        },
      ]);
    });

    it('should support manual shared bundles with internalized assets', async function () {
      await fsFixture(overlayFS, dir)`
      yarn.lock:
        // Required for config loading
      package.json:
        {
          "@parcel/transformer-js" : {
            "unstable_inlineConstants": true
          },
          "@parcel/bundler-default": {
            "minBundleSize": 0,
            "manualSharedBundles": [{
              "name": "vendor",
              "root": "manual.js",
              "assets": ["**/*"],
              "types": ["js"]
            }]
          }
        }

      index.html:
        <script type="module" src="./index.js"></script>

      index.js:
        import a from './manual.js';

      manual.js:
        import v from './vendor-async.js';
        import n from './vendor';
        export default 'async' + v;

      vendor.js:
        export const n = () => import('./vendor-async');

      vendor-async.js:
        export default 'vendor-async.js';
      `;

      let b = await bundle(path.join(dir, 'index.html'), {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          sourceMaps: false,
          shouldOptimize: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          assets: ['esmodule-helpers.js', 'index.js'],
        },
        {
          // Vendor MSB for JS
          assets: ['manual.js', 'vendor.js', 'vendor-async.js'],
        },
      ]);

      let targetDistDir = normalizePath(path.join(__dirname, '../dist'));
      let hashedIdWithMSB = hashString('bundle:' + 'vendorjs' + targetDistDir);
      assert(
        b.getBundles().find(b => b.id == hashedIdWithMSB),
        'MSB id does not match expected',
      );

      await run(b);
    });

    it('should support consistently splitting manual shared bundles', async function () {
      await fsFixture(overlayFS, dir)`
        yarn.lock:
          // Required for config loading
        package.json:
          {
            "@parcel/bundler-default": {
              "minBundleSize": 0,
              "manualSharedBundles": [{
                "name": "vendor",
                "root": "vendor.js",
                "assets": ["**/*"],
                "split": 3
              }]
            }
          }

        index.html:
          <script type="module" src="./index.js"></script>

        index.js:
          import * as vendor from './vendor';
          sideEffectNoop(vendor);

        vendor.js:
          export * from './a';
          export * from './b';
          export * from './c';
          export * from './d';
          export * from './e';
          export * from './f';
          export * from './g';
          export * from './h';
          export * from './i';
          export * from './j';

        a.js:
          export const a = 'a';
        b.js:
          export const b = 'b';
        c.js:
          export const c = 'c';
        d.js:
          export const d = 'd';
        e.js:
          export const e = 'e';
        f.js:
          export const f = 'f';
        g.js:
          export const g = 'g';
        h.js:
          export const h = 'h';
        i.js:
          export const i = 'i';
        j.js:
          export const j = 'j';
      `;

      let b = await bundle(path.join(dir, 'index.html'), {
        defaultTargetOptions: {
          shouldScopeHoist: false,
          shouldOptimize: false,
          sourceMaps: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {
          assets: ['index.html'],
        },
        {
          assets: ['a.js', 'i.js'],
        },
        {
          assets: ['vendor.js', 'b.js', 'j.js'],
        },
        {
          assets: ['c.js', 'd.js', 'e.js', 'f.js', 'g.js', 'h.js'],
        },
        {
          assets: ['esmodule-helpers.js', 'index.js'],
        },
      ]);
    });

    it('should support globs matching outside of the project root', async function () {
      const rootDir = path.join(dir, 'root');
      overlayFS.mkdirp(rootDir);
      await fsFixture(overlayFS, rootDir)`
      yarn.lock:
        // Required for config loading

      package.json:
        {
          "@parcel/bundler-default": {
            "minBundleSize": 0,
            "manualSharedBundles": [{
              "name": "vendor",
              "root": "vendor.js",
              "assets": [
                "in-project.js",
                "../outside-project.js"
              ]
            }]
          }
        }

      index.html:
        <script type="module" src="./index.js"></script>

      in-project.js:
        export default 'in-project';

      vendor.js:
        export * from './in-project';
        export * from '../outside-project';

      index.js:
        import * as vendor from './vendor';

        console.log(vendor.inProj);
        console.log(vendor.outProj);`;

      await fsFixture(overlayFS, dir)`
      outside-project.js:
        export default 'outside-project';`;

      let b = await bundle(path.join(rootDir, 'index.html'), {
        defaultTargetOptions: {
          shouldScopeHoist: false,
          shouldOptimize: false,
          sourceMaps: false,
        },
        inputFS: overlayFS,
      });

      assertBundles(b, [
        {assets: ['index.html']},
        {assets: ['in-project.js', 'outside-project.js']},
        {assets: ['esmodule-helpers.js', 'index.js', 'vendor.js']},
      ]);
    });
  });

  it('should reuse type change bundles from parent bundle groups', async function () {
    await fsFixture(overlayFS, __dirname)`
      reuse-type-change-bundles
        index.html:
          <link rel="stylesheet" type="text/css" href="./style.css">
          <script src="./index.js" type="module"></script>

        style.css:
          @import "common.css";
          body { color: red }

        common.css:
          .common { color: green }

        index.js:
          import('./async');

        async.js:
          import './common.css';
    `;

    let b = await bundle(
      path.join(__dirname, 'reuse-type-change-bundles', 'index.html'),
      {
        mode: 'production',
        inputFS: overlayFS,
      },
    );

    assertBundles(b, [
      {
        assets: ['index.html'],
      },
      {
        assets: ['style.css', 'common.css'],
      },
      {
        assets: ['index.js', 'bundle-manifest.js', 'esm-js-loader.js'],
      },
      {
        assets: ['async.js'],
      },
    ]);
  });
});
