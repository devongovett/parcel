import assert from 'assert';
import path from 'path';
import {pathToFileURL} from 'url';
import nullthrows from 'nullthrows';
import {
  assertBundles,
  assertESMExports,
  bundle as _bundle,
  mergeParcelOptions,
  outputFS,
  run,
  runBundle,
} from '@parcel/test-utils';
import * as react from 'react';
import * as lodash from 'lodash';
import * as lodashFP from 'lodash/fp';

const bundle = (name, opts = {}) => {
  return _bundle(
    name,
    mergeParcelOptions(
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
      opts,
    ),
  );
};

describe('output formats', function () {
  describe('commonjs', function () {
    it('should support commonjs output (exports)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs/exports.js'),
      );

      assert.equal((await run(b)).bar, 5);
    });

    it('should support commonjs output (module.exports)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs/module-exports.js'),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(!dist.includes('function')); // no iife
      assert.equal(await run(b), 5);
    });

    it('should support commonjs output from esmodule input', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-commonjs/a.js'),
      );

      assert.equal((await run(b)).bar, 5);
    });

    it('should support commonjs output from esmodule input (re-export rename)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-commonjs/re-export-rename.js',
        ),
      );

      assert.equal((await run(b)).default, 2);
    });

    it.skip('should support commonjs output from esmodule input (re-export namespace as)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-commonjs/re-export-namespace-as.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('exports.ns'));
      let output = await run(b);
      assert.equal(output.ns.default, 4);
      assert.equal(output.ns.bar, 5);
    });

    it('should support commonjs output from esmodule input (same binding multiple exports)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-commonjs/multiple-times.js',
        ),
      );

      assert.deepStrictEqual(await run(b), {
        default: 1,
        test: 1,
        other: 1,
        foo: 2,
      });
    });

    it('should support commonjs output from esmodule input (skipped exports)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-commonjs-isLibrary-false/skipped.js',
        ),
      );

      assert.deepEqual(await run(b), {});
    });

    it('should support commonjs output with external modules (require)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-external/require.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('require("lodash")'));
      assert.equal((await run(b)).bar, 3);
    });

    it('should support commonjs output with external modules (named import)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-external/named.js'),
      );

      assert.equal((await run(b)).bar, 3);
    });

    it('should support commonjs output with external modules (named import with same name)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-external/named-same.js',
        ),
      );

      assert.equal((await run(b)).bar, true);
    });

    it('should support commonjs output with external modules (namespace import)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-external/namespace.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('= require("lodash")'));
      assert.equal((await run(b)).bar, 3);
    });

    it('should support commonjs output with external modules (default import)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-external/default.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('$parcel$interopDefault'));
      assert.equal((await run(b)).bar, 3);
    });

    it('should support commonjs output with external modules (default import new call)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-external/default-new.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('$parcel$interopDefault'));
      await run(b);
    });

    it('should support commonjs output with external modules (multiple specifiers)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-external/multiple.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('= require("lodash")'));
      assert(dist.includes('= (0, ($parcel$interopDefault('));
      assert(/var {add: \s*\$.+?\$add\s*} = lodash/);
      assert.equal((await run(b)).bar, 6);
    });

    it('should support commonjs output with old node without destructuring (single)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-destructuring-node/single.js',
        ),
      );

      assert.equal((await run(b)).bar, 3);
    });

    it('should support commonjs output with old node without destructuring (multiple single with same name)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-destructuring-node/single-same.js',
        ),
      );

      assert.equal((await run(b)).bar, true);
    });

    it('should support commonjs output with old node without destructuring (multiple)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-destructuring-node/multiple.js',
        ),
      );

      assert.equal((await run(b)).bar, 2);
    });

    it('should support commonjs output with old browsers without destructuring (single)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-destructuring-browsers/single.js',
        ),
      );

      assert.equal((await run(b, {require})).bar, 3);
    });

    it('should support commonjs output with old node without destructuring (multiple)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-destructuring-browsers/multiple.js',
        ),
      );

      assert.equal((await run(b, {require})).bar, 2);
    });

    it('should support importing sibling bundles in library mode', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-siblings/a.js'),
      );

      let dist = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'js').filePath,
        'utf8',
      );
      assert(dist.includes('require("./index.css")'));
    });

    it('should support async imports', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-async/index.js'),
      );

      let index = await outputFS.readFile(
        b.getBundles().find(b => b.name.startsWith('index')).filePath,
        'utf8',
      );
      assert(/Promise\.resolve\(require\("\.\/async\..+?\.js"\)\)/.test(index));

      assert.equal(await run(b), 4);
    });

    it('should support async split bundles', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-split/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );

      let index = await outputFS.readFile(
        b.getBundles().find(b => b.name.startsWith('index')).filePath,
        'utf8',
      );
      assert(
        /Promise\.resolve\(require\("\.\/async1\..+?\.js"\)\)/.test(index),
      );
      assert(
        /Promise\.resolve\(require\("\.\/async2\..+?\.js"\)\)/.test(index),
      );
    });

    it('should support async split bundles (reexport default)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-split-reexport-default/index.js',
        ),
        {mode: 'production'},
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js'],
        },
        {
          type: 'js',
          assets: ['shared.js'],
        },
        {
          type: 'js',
          assets: ['async1.js'],
        },
        {
          type: 'js',
          assets: ['async2.js'],
        },
      ]);

      assert.strictEqual(await run(b), 20579 * 2);
    });

    it('should call init for wrapped modules when codesplitting to to commonjs', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-wrap-codesplit/a.js',
        ),
      );

      assert.equal(await run(b), 2);
    });

    it('should support sideEffects: false', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-sideeffects/index.js',
        ),
      );

      let ns = await run(b);
      assert.equal(typeof ns.test, 'function');
    });

    it('should throw an error on missing export with esmodule input and sideEffects: false', async function () {
      let message = "other.js does not export 'a'";
      let source = path.join(
        __dirname,
        '/integration/formats/commonjs-sideeffects',
        'missing-export.js',
      );
      await assert.rejects(
        () =>
          bundle(
            path.join(
              __dirname,
              '/integration/formats/commonjs-sideeffects',
              'missing-export.js',
            ),
          ),
        {
          name: 'BuildError',
          message,
          diagnostics: [
            {
              message,
              origin: '@parcel/core',
              codeFrames: [
                {
                  filePath: source,
                  language: 'js',
                  codeHighlights: [
                    {
                      message: undefined,
                      start: {
                        line: 1,
                        column: 10,
                      },
                      end: {
                        line: 1,
                        column: 15,
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

    it('should support commonjs input', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-dynamic/index.js'),
      );

      let dist = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'js').filePath,
        'utf8',
      );
      assert(dist.includes('Object.assign(module.exports'));

      let ns = await run(b);
      assert.equal(typeof ns.test, 'function');
    });

    it('should support commonjs requires without interop', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-require/index.js'),
      );

      let dist = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'js').filePath,
        'utf8',
      );
      assert(dist.includes('= require("lodash")'));

      let add = await run(b);
      assert.equal(add(2, 3), 5);
    });

    it('should support generating commonjs output with re-exports in entry', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-entry-re-export/a.js',
        ),
      );
      assert.deepEqual(await run(b), {foo: 'foo'});
    });

    it('should compile workers to statically analyzable URL expressions', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/workers-module/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            outputFormat: 'commonjs',
            shouldScopeHoist: true,
            shouldOptimize: false,
            isLibrary: true,
          },
        },
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      let workerBundle = b
        .getBundles()
        .find(b => b.name.startsWith('dedicated-worker'));
      let sharedWorkerBundle = b
        .getBundles()
        .find(b => b.name.startsWith('shared-worker'));
      assert(
        contents.includes(
          `new Worker(new URL("${path.basename(
            workerBundle.filePath,
          )}", "file:" + __filename)`,
        ),
      );
      assert(
        contents.includes(
          `new SharedWorker(new URL("${path.basename(
            sharedWorkerBundle.filePath,
          )}", "file:" + __filename)`,
        ),
      );
    });

    it('should compile url: pipeline dependencies to statically analyzable URL expressions for libraries', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/worklet/pipeline.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            outputFormat: 'commonjs',
            shouldScopeHoist: true,
            shouldOptimize: false,
            isLibrary: true,
          },
        },
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes(
          `new URL("${path.basename(
            b.getBundles()[1].filePath,
          )}", "file:" + __filename)`,
        ),
      );
    });

    it('should URL dependencies to statically analyzable URL expressions for libraries', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/worklet/url.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            outputFormat: 'commonjs',
            shouldScopeHoist: true,
            shouldOptimize: false,
            isLibrary: true,
          },
        },
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes(
          `new URL("${path.basename(
            b.getBundles()[1].filePath,
          )}", "file:" + __filename)`,
        ),
      );
    });

    it('should support live binding of external modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-live-externals/a.js',
        ),
      );

      let external = {
        foo: 1,
        setFoo(f) {
          this.foo = f;
        },
      };

      let out = [];
      await run(
        b,
        {
          output(o) {
            out.push(o);
          },
        },
        {},
        {
          external: () => external,
        },
      );

      assert.deepEqual(out, [1, 2]);
    });

    it('should work with SWC helpers', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-helpers/index.js'),
      );

      let out = [];
      await run(b, {
        require,
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out[0].x, new Map());
    });
  });

  describe('esmodule', function () {
    it('should support esmodule output (named export)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/named.js'),
      );

      await assertESMExports(b, {bar: 5, foo: 2});
    });

    it('should support esmodule output (default identifier)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/default-value.js'),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(!dist.includes('function')); // no iife
      await assertESMExports(b, {default: 4});
    });

    it('should support esmodule output (default function)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/default-function.js'),
      );

      assert.strictEqual((await run(b)).default(), 2);
    });

    it('should support esmodule output (multiple)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/multiple.js'),
      );

      await assertESMExports(b, {a: 2, c: 5, default: 3});
    });

    it('should support esmodule output (exporting symbol multiple times)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/multiple-times.js'),
      );

      await assertESMExports(b, {default: 1, foo: 2, other: 1, test: 1});
    });

    it('should support esmodule output (re-export)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/re-export.js'),
      );

      await assertESMExports(b, {a: 2, c: 5});
    });

    it.skip('should support esmodule output (re-export namespace as)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm/re-export-namespace-as.js',
        ),
      );

      await assertESMExports(b, {ns: {a: 2, c: 5}});
    });

    it('should support esmodule output (renaming re-export)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm/re-export-rename.js'),
      );

      await assertESMExports(b, {foo: 4});
    });

    it('should support esmodule output with external modules (named import)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/named.js'),
      );

      await assertESMExports(
        b,
        {bar: 3},
        {lodash: () => ({add: (a, b) => a + b})},
      );
    });

    it('should support esmodule output with external modules (named import with same name)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/named-same.js'),
      );

      await assertESMExports(
        b,
        {bar: true},
        {
          lodash: () => lodash,
          'lodash/fp': () => lodashFP,
        },
      );
    });

    it('should support esmodule output with external modules (namespace import)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/namespace.js'),
      );

      await assertESMExports(b, {bar: 3}, {lodash: () => lodash});
    });

    it('should support esmodule output with external modules (default import)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/default.js'),
      );

      await assertESMExports(
        b,
        {bar: 3},
        {
          lodash: () => lodash,
        },
      );
    });

    it('should support esmodule output with external modules (multiple specifiers)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/multiple.js'),
      );

      await assertESMExports(
        b,
        {bar: 6},
        {
          lodash: () => lodash,
        },
      );
    });

    it('should support esmodule output with external modules (export)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/export.js'),
      );

      await assertESMExports(
        b,
        3,
        {
          lodash: () => lodash,
        },
        ns => ns.add(1, 2),
      );
    });

    it('should support esmodule output with external modules (re-export)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-external/re-export.js'),
      );

      await assertESMExports(
        b,
        3,
        {
          lodash: () => lodash,
        },
        ns => ns.add(1, 2),
      );
    });

    it('should support esmodule output with external modules (re-export child)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-external/re-export-child.js',
        ),
      );

      await assertESMExports(
        b,
        3,
        {
          lodash: () => lodash,
        },
        ns => ns.add(1, 2),
      );
    });

    it('should support importing sibling bundles in library mode', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-siblings/a.js'),
      );

      let dist = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'js').filePath,
        'utf8',
      );
      assert(dist.includes('import "./index.css"'));
    });

    it('should support esmodule output (skipped exports)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-isLibrary-false/skipped.js',
        ),
      );

      let dist = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'js').filePath,
        'utf8',
      );
      assert(!dist.includes('foo'));
    });

    it('should support interop imports from other bundles', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-interop-cross-bundle/a.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['a.js', 'c.js'],
        },
        {
          type: 'js',
          assets: ['b.js'],
        },
      ]);

      let dist = await outputFS.readFile(
        b.getBundles().find(b => !b.needsStableName).filePath,
        'utf8',
      );
      assert(dist.includes('$parcel$interopDefault'));
      let ns = await run(b);
      assert.deepEqual(await ns.default, [123, 123]);
    });

    it('should rename imports that conflict with exports', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-conflict/a.js'),
      );

      await assertESMExports(b, {foo: 13}, {foo: () => ({foo: 10})});
    });

    it('should support async imports', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-async/index.js'),
      );

      let index = await outputFS.readFile(
        b.getBundles().find(b => b.name.startsWith('index')).filePath,
        'utf8',
      );
      assert(/import\("\.\/async\..+?\.js"\)/.test(index));

      await assertESMExports(b, 4, {}, ns => ns.default);
    });

    // This is currently not possible, it would have to do something like this:
    // export { $id$init().foo as foo };
    it.skip('should support dynamic imports with chained reexports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-async-chained-reexport/index.js',
        ),
      );

      let async = await outputFS.readFile(
        b.getBundles().find(b => b.name.startsWith('c')).filePath,
        'utf8',
      );
      assert(!/\$export\$default\s+=/.test(async));
    });

    it('should support dynamic imports with chained reexports II', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-async-chained-reexport2/index.js',
        ),
      );

      let async = await outputFS.readFile(
        b.getChildBundles(b.getBundles()[0])[0].filePath,
        'utf8',
      );
      assert(!async.includes('$import$'));
      await assertESMExports(b, ['index', 'a', 1], {}, ns => ns.default);
    });

    it('should throw an error on missing export with esmodule output and sideEffects: false', async function () {
      let message = "b.js does not export 'a'";
      let source = path.join(
        __dirname,
        'integration/formats/esm-sideeffects',
        'missing-export.js',
      );
      await assert.rejects(
        () =>
          bundle(
            path.join(
              __dirname,
              'integration/formats/esm-sideeffects/missing-export.js',
            ),
          ),
        {
          name: 'BuildError',
          message,
          diagnostics: [
            {
              message,
              origin: '@parcel/core',
              codeFrames: [
                {
                  filePath: source,
                  language: 'js',
                  codeHighlights: [
                    {
                      message: undefined,
                      start: {
                        line: 1,
                        column: 10,
                      },
                      end: {
                        line: 1,
                        column: 15,
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

    it('should support async split bundles', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-split/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );

      let index = await outputFS.readFile(
        b.getBundles().find(b => b.name.startsWith('index')).filePath,
        'utf8',
      );
      assert(/import\("\.\/async1\..+?\.js"\)/.test(index));
      assert(/import\("\.\/async2\..+?\.js"\)/.test(index));

      await assertESMExports(
        b,
        true,
        {lodash: () => lodash, react: () => react},
        ns => ns.default,
      );
    });

    it('should call init for wrapped modules when codesplitting to esmodules', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-wrap-codesplit/a.js'),
      );

      let ns = await run(b);
      // TODO: https://github.com/parcel-bundler/parcel/issues/5459
      assert.deepStrictEqual(await ns.default, 2);
    });

    it('should support async split bundles for workers', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-split-worker/index.html',
        ),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );

      let workerBundle = nullthrows(
        b.getBundles().find(b => b.env.context === 'web-worker'),
      );
      let workerBundleContents = await outputFS.readFile(
        workerBundle.filePath,
        'utf8',
      );

      let asyncBundle = b
        .getChildBundles(workerBundle)
        .find(b => b.filePath.includes('async'));
      let syncBundle = b
        .getReferencedBundles(workerBundle)
        .find(b => !b.filePath.includes('async'));
      assert(
        workerBundleContents.includes(
          `import "./${path.basename(syncBundle.filePath)}"`,
        ),
      );
      assert(
        workerBundleContents.includes(path.basename(asyncBundle.filePath)),
      );
    });

    it('should support building esmodules for browser targets', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-browser/index.html'),
      );

      let html = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'html').filePath,
        'utf8',
      );

      assert(html.includes('<script type="module" src="/index'));

      let entry = await outputFS.readFile(
        b
          .getBundles()
          .find(
            b => path.basename(b.filePath) === html.match(/src="\/(.*?)"/)[1],
          ).filePath,
        'utf8',
      );

      let asyncBundle = b
        .getBundles()
        .find(bundle => bundle.name.startsWith('async'));
      assert(
        entry.includes(`import("./${path.basename(asyncBundle.filePath)}")`),
      );

      let res = await run(b, {output: null}, {require: false});
      assert.equal(await res.output, 4);
    });

    it('should support using an import polyfill for older browsers', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-browser/index.html'),
        {
          defaultTargetOptions: {
            engines: {
              browsers: [
                // Implements es modules but not dynamic imports
                'Chrome 61',
              ],
            },
          },
        },
      );

      let html = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'html').filePath,
        'utf8',
      );

      assert(html.includes('<script type="module" src="/index'));

      let entry = await outputFS.readFile(
        b
          .getBundles()
          .find(
            b => path.basename(b.filePath) === html.match(/src="\/(.*?)"/)[1],
          ).filePath,
        'utf8',
      );
      assert(entry.includes('function importModule'));

      let asyncBundle = b
        .getBundles()
        .find(bundle => bundle.name.startsWith('async'));
      assert(
        entry.includes(
          `$parcel$resolve("${path.basename(asyncBundle.filePath)}")`,
        ),
      );
    });

    it('should support building esmodules with css imports', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-browser-css/index.html'),
      );

      let html = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'html').filePath,
        'utf8',
      );

      assert(html.includes('<script type="module" src="/index'));
      assert(html.includes('<link rel="stylesheet" href="/index'));

      let entry = await outputFS.readFile(
        b
          .getBundles()
          .find(
            b => path.basename(b.filePath) === html.match(/src="\/(.*?)"/)[1],
          ).filePath,
        'utf8',
      );

      let bundles = b.getBundles();
      let asyncJsBundle = bundles.find(
        bundle => bundle.type === 'js' && bundle.name.startsWith('async'),
      );
      let asyncCssBundle = bundles.find(
        bundle => bundle.type === 'css' && bundle.name.startsWith('async'),
      );
      assert(
        new RegExp(
          'Promise.all\\(\\[\\n.+?\\$parcel\\$resolve\\("' +
            path.basename(asyncCssBundle.filePath) +
            '"\\)\\),\\n\\s*import\\("\\.\\/' +
            path.basename(asyncJsBundle.filePath) +
            '"\\)\\n\\s*\\]\\)',
        ).test(entry),
      );

      let async = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'js' && b.name.startsWith('async'))
          .filePath,
        'utf8',
      );
      assert(!async.includes('.css"'));
    });

    it('should support building esmodules with split bundles', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-browser-split-bundle/index.html',
        ),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );

      let html = await outputFS.readFile(
        b.getBundles().find(b => b.type === 'html').filePath,
        'utf8',
      );

      assert(html.includes('<script type="module" src="/index'));
      assert(html.includes('<script type="importmap"'));

      let bundles = b.getBundles();
      let entry = await outputFS.readFile(
        bundles.find(
          b => path.basename(b.filePath) === html.match(/src="\/(.*?)"/)[1],
        ).filePath,
        'utf8',
      );

      let sharedBundle = bundles.find(b => b.getEntryAssets().length === 0);
      let async1Bundle = bundles.find(
        b => b.name.startsWith('async1') && b.id !== sharedBundle.id,
      );
      let async2Bundle = bundles.find(b => b.name.startsWith('async2'));

      for (let bundle of [async1Bundle, async2Bundle]) {
        // async import both bundles in parallel for performance
        assert(
          new RegExp(
            `import\\("${sharedBundle.publicId}"\\),\\n\\s*import\\("${bundle.publicId}"\\)`,
          ).test(entry),
        );
      }
    });

    it('should create correct bundle import for reexports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/esm-bundle-import-reexport/index.js',
        ),
      );

      await assertESMExports(
        b,
        ['!!!index!!!', 'DiagramVersion: !!!some name!!!'],
        {},
        ns => ns.default,
      );
    });

    it('should support generating ESM from CommonJS', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-esm/index.js'),
      );

      let ns = await run(b, {}, {}, {lodash: () => lodash});
      assert.strictEqual(ns.default(1, 2), 3);
    });

    it('should support re-assigning to module.exports', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/commonjs-esm/re-assign.js'),
      );

      let ns = await run(b);
      assert.deepStrictEqual({...ns}, {default: 'xyz'});
    });

    it.skip("doesn't support require.resolve calls for excluded assets without commonjs", async function () {
      let message =
        "'require.resolve' calls for excluded assets are only supported with outputFormat: 'commonjs'";
      let source = path.join(
        __dirname,
        '/integration/formats/commonjs-esm/require-resolve.js',
      );
      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message,
        diagnostics: [
          {
            message,
            origin: '@parcel/packager-js',
            codeFrames: [
              {
                filePath: source,
                language: 'js',
                codeHighlights: [
                  {
                    start: {
                      line: 1,
                      column: 16,
                    },
                    end: {
                      line: 1,
                      column: 40,
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it('should support generating commonjs output with re-exports in entry', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/commonjs-esm-entry-re-export/a.js',
        ),
      );

      let ns = await run(b);
      assert.deepEqual({...ns}, {default: {default: 'default'}});
    });

    it('should support rewriting filename and importing path', async function () {
      let input = path.join(
        __dirname,
        '/integration/formats/esm-filename-import/index.js',
      );
      let b = await bundle(input);

      let ns = await run(b);
      assert.deepEqual(ns.foo, input);
    });

    it('should rename shadowed imported specifiers to something unique', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-import-shadow/a.mjs'),
      );

      let _b = await import(
        pathToFileURL(
          path.join(
            __dirname,
            '/integration/formats/esm-import-shadow/node_modules/b/index.mjs',
          ),
        ).toString()
      );
      let ns = await run(b, {}, {}, {b: () => _b});
      let [useContext] = ns.createContext('Hello');
      assert.strictEqual(useContext(), 'Hello World');
    });

    it('should rename shadowed exports to something unique', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-export-shadow/a.mjs'),
      );

      let ns = await run(b);
      assert.strictEqual(ns.fib(5), 8);
    });

    it('should support ESM output from CJS input', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-cjs/a.js'),
      );

      let ns = await run(b);
      assert.deepEqual(ns.test, true);
      assert.deepEqual(ns.default, {test: true, 'foo-bar': true});
      assert.deepEqual(ns['foo-bar'], true);
    });

    it('should support outputting .mjs files', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-mjs/index.js'),
      );

      let filePath = b.getBundles()[0].filePath;
      assert(filePath.endsWith('.mjs'));
      let output = await outputFS.readFile(filePath, 'utf8');
      assert(output.includes('import '));
    });

    it('should support outputting ESM in .js files with "type": "module"', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/esm-type-module/index.js'),
      );

      let filePath = b.getBundles()[0].filePath;
      assert(filePath.endsWith('.js'));
      let output = await outputFS.readFile(filePath, 'utf8');
      assert(output.includes('import '));
    });

    it('.cjs extension should override "type": "module"', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/formats/cjs-type-module/index.js'),
      );

      let filePath = b.getBundles()[0].filePath;
      assert(filePath.endsWith('.cjs'));
      let output = await outputFS.readFile(filePath, 'utf8');
      assert(!output.includes('import '));
      assert(output.includes('require('));
    });

    it('should compile workers to statically analyzable URL expressions', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/workers-module/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            shouldScopeHoist: true,
            shouldOptimize: false,
            isLibrary: true,
          },
        },
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      let workerBundle = b
        .getBundles()
        .find(b => b.name.startsWith('dedicated-worker'));
      let sharedWorkerBundle = b
        .getBundles()
        .find(b => b.name.startsWith('shared-worker'));
      assert(
        contents.includes(
          `new Worker(new URL("${path.basename(
            workerBundle.filePath,
          )}", import.meta.url)`,
        ),
      );
      assert(
        contents.includes(
          `new SharedWorker(new URL("${path.basename(
            sharedWorkerBundle.filePath,
          )}", import.meta.url)`,
        ),
      );
    });

    it('should compile url: pipeline dependencies to statically analyzable URL expressions for libraries', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/worklet/pipeline.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            shouldScopeHoist: true,
            shouldOptimize: false,
            isLibrary: true,
          },
        },
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes(
          `new URL("${path.basename(
            b.getBundles()[1].filePath,
          )}", import.meta.url)`,
        ),
      );
    });

    it('should URL dependencies to statically analyzable URL expressions for libraries', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/worklet/url.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            outputFormat: 'esmodule',
            shouldScopeHoist: true,
            shouldOptimize: false,
            isLibrary: true,
          },
        },
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        contents.includes(
          `new URL("${path.basename(
            b.getBundles()[1].filePath,
          )}", import.meta.url)`,
        ),
      );
    });
  });

  it('should support generating ESM from universal module wrappers', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/formats/commonjs-esm/universal-library.js',
      ),
    );

    let ns = await run(b);
    assert.deepEqual({...ns}, {default: {a: 2}});
  });

  it("doesn't overwrite used global variables", async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/formats/conflict-global/index.js'),
    );

    let cjs = b
      .getBundles()
      .find(b => b.type === 'js' && b.env.outputFormat === 'commonjs');

    let calls = [];
    assert.deepEqual(
      await runBundle(b, cjs, {
        foo(v) {
          calls.push(v);
        },
      }),
      {Map: 2},
    );
    assert.deepEqual(calls, [[['a', 10]]]);

    calls = [];
    assert.deepEqual(
      await runBundle(b, cjs, {
        foo(v) {
          calls.push(v);
        },
      }),
      {Map: 2},
    );
    assert.deepEqual(calls, [[['a', 10]]]);
  });

  it('should support external parallel dependencies', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/library-parallel-deps/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'out.js',
        assets: ['index.js'],
      },
      {
        assets: ['foo.js'],
      },
    ]);

    let res = await run(b);
    assert.equal(res.default, 'foo bar');

    let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(/import [^\s]+ from "\.\//.test(content));
  });

  describe('global', function () {
    it.skip('should support split bundles between main script and workers', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/formats/global-split-worker/index.html',
        ),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['get-worker-url.js', 'index.js'],
        },
        {type: 'html', assets: ['index.html']},
        {type: 'js', assets: ['lodash.js']},
        {type: 'js', assets: ['worker.js']},
      ]);

      let workerBundle;
      let res = await run(
        b,
        {
          output: null,
          Worker: class {
            constructor(url) {
              workerBundle = nullthrows(
                b
                  .getBundles()
                  .find(
                    b => path.basename(b.filePath) === path.posix.basename(url),
                  ),
              );
            }
          },
        },
        {require: false},
      );
      assert.strictEqual(res.output, 3);
      res = await runBundle(b, workerBundle, {output: null}, {require: false});
      assert.strictEqual(res.output, 30);
    });

    it('should support async split bundles for workers', async function () {
      await bundle(
        path.join(
          __dirname,
          '/integration/formats/global-split-worker-async/index.html',
        ),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );
    });

    it('should throw with external modules', async function () {
      let message =
        'External modules are not supported when building for browser';
      let source = path.join(
        __dirname,
        'integration/formats/global-external/index.js',
      );
      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message,
        diagnostics: [
          {
            message,
            origin: '@parcel/packager-js',
            codeFrames: [
              {
                filePath: source,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 21,
                    },
                    end: {
                      line: 1,
                      column: 28,
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    });
  });
});
