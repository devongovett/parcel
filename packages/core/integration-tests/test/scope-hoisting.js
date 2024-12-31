import assert from 'assert';
import path from 'path';
import nullthrows from 'nullthrows';
import {normalizePath} from '@parcel/utils';
import {createWorkerFarm} from '@parcel/core';
import {md} from '@parcel/diagnostic';
import {
  assertBundles,
  bundle as _bundle,
  bundler as _bundler,
  distDir,
  findAsset,
  findDependency,
  getNextBuild,
  mergeParcelOptions,
  outputFS,
  overlayFS,
  run,
  runBundle,
  fsFixture,
} from '@parcel/test-utils';

const bundle = (name, opts = {}) => {
  return _bundle(
    name,
    // $FlowFixMe
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

const bundler = (name, opts = {}) => {
  return _bundler(
    name,
    // $FlowFixMe
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

describe('scope hoisting', function () {
  describe('es6', function () {
    it('supports default imports and exports of expressions', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/default-export-expression/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports default imports and exports of declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/default-export-declaration/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports default imports and exports of anonymous declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/default-export-anonymous/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports default imports and exports of variables', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/default-export-variable/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports named imports and exports of declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/named-export-declaration/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports named imports and exports of variables', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/named-export-variable/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports named exports of variables with a different name', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/named-export-variable-rename/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports named exports of variables with a different name when wrapped', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/named-export-variable-rename-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports dependency rewriting for import * as from a library that has export *', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/rewrite-export-star/index.js',
        ),
        {mode: 'production'},
      );
      let output = await run(b);
      assert.equal(output, 2);

      assert.deepStrictEqual(
        new Set(
          b.getUsedSymbols(findDependency(b, 'index.js', './library/a.js')),
        ),
        new Set(['bar']),
      );
    });

    it('supports renaming non-ASCII identifiers', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/non-ascii-identifiers/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [1, 2, 3, 4]);
    });

    it('supports renaming superclass identifiers', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/rename-superclass/a.js',
        ),
      );
      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports renaming helpers inserted during transpiling', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/rename-helpers/a.js',
        ),
      );
      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(/let \S* = Symbol.toStringTag;/.test(contents));

      let output = await run(b);
      assert.deepEqual(output, ['1', '2']);
    });

    it('correctly renames member expression properties', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/rename-member-prop/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output({foo: 12, bar: 34}), [12, 12, 34, 34]);
    });

    it('supports renaming imports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/renamed-import/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports renaming exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/renamed-export/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports importing from a reexporting asset in an anchestor (1)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/ancestor-reexport/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, ['index', 'async']);
    });

    it('supports importing from a reexporting asset in an anchestor (2)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/ancestor-reexport2/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [123, 123]);
    });

    it('supports importing from a reexporting asset in an anchestor (3)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/ancestor-reexport2/b.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [123, 123]);
    });

    it('supports async import of internalized asset with unused return value', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/async-internalize-unused/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 'bc');
    });

    it('supports importing a namespace of exported values', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports namespace imports of excluded assets (node_modules)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-external/a.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );

      assert(contents.includes('require("lodash")'));

      let output = await run(b);
      assert.deepEqual(output.default, 12);
    });

    it('supports re-exporting all exports from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 6);
    });

    it('supports re-exporting all when falling back to namespace at runtime 1', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-fallback-1/index.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 2);
    });

    it('supports re-exporting all when falling back to namespace at runtime 2', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-fallback-2/index.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 2);
    });

    it('supports re-exporting all when falling back to namespace at runtime 3', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/re-export-all-fallback-3/entry.js',
        ),
      );
      let output = await run(b);
      assert.strictEqual(output, 'FOOBAR!');
    });

    it('supports nested re-exporting all when falling back to namespace at runtime', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-fallback-nested/index.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, '2 4');
    });

    it('supports re-exporting all from an empty module without side effects', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-empty-no-side-effects/index.js',
        ),
        {
          mode: 'production',
        },
      );

      let output = await run(b);
      assert.strictEqual(output, 'foo bar');

      let contents = await outputFS.readFile(
        b.getBundles().find(b => b.getMainEntry().filePath.endsWith('index.js'))
          .filePath,
        'utf8',
      );
      assert.match(contents, /output="foo bar"/);
    });

    it('supports re-exporting all with ambiguous CJS and non-renaming and renaming dependency retargeting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-ambiguous/entry.js',
        ),
        {
          mode: 'production',
        },
      );

      let output = await run(b);
      assert.strictEqual(output, '123 999');
    });

    it('supports re-exporting all exports from an external module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-external/a.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['a.js', 'b.js'],
        },
      ]);

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'b.js', 'lodash'))),
        new Set(['add']),
      );

      // getSymbolResolution is broken
      // let output = await run(b);
      // assert.equal(output, 3);
    });

    it('supports re-exporting all exports from multiple modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-multiple/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 15);
    });

    it('supports re-exporting all exports and overriding individual exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-all-override/index.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 'fooBfooCC');
    });

    it('can import from a different bundle via a re-export (1)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-bundle-boundary/index.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, ['operational', 'ui']);
    });

    it('can import from a different bundle via a re-export (2)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-bundle-boundary2/index.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, ['foo', 'foo']);
    });

    it('can import from its own bundle with a split package', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-bundle-boundary3/index.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [['a', 'b'], 'themed']);
    });

    it('supports importing all exports re-exported from multiple modules deep', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-multiple-wildcards/a.js',
        ),
      );

      let {foo, bar, baz, a, b: bb} = await run(b);
      assert.equal(foo + bar + baz + a + bb, 15);
    });

    it('deduplicates imports when wrapped', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-multiple-wrapped/index.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );

      let assetB = nullthrows(
        b.getBundles()[0]?.traverseAssets((a, _, actions) => {
          if (
            a.filePath ===
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/import-multiple-wrapped/b.js',
            )
          ) {
            actions.stop();
            return a;
          }
        }),
      );
      assert.equal(
        [
          ...contents.matchAll(
            new RegExp(
              'parcelRequires*\\(s*"' + b.getAssetPublicId(assetB) + '"s*\\)',
              'g',
            ),
          ),
        ].length,
        1,
      );

      let output = await run(b);
      assert.equal(output, 15);
    });

    it('supports re-exporting all exports from multiple modules deep', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-multiple/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 7);
    });

    it('supports re-exporting individual named exports from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-named/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 3);
    });

    it('supports re-exporting default exports from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-default/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 3);
    });

    it('supports re-exporting a namespace from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-namespace/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 6);
    });

    it('supports re-exporting a namespace from another module (chained)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-namespace-chained/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        Bar: {
          A: 1,
          B: 2,
        },
        Foo: {
          A: 1,
          B: 2,
        },
      });
    });

    it('has the correct order with namespace re-exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-namespace-order/index.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, Symbol.for('abc'));
    });

    it('excludes default when re-exporting a module', async function () {
      let source = path.normalize(
        'integration/scope-hoisting/es6/re-export-exclude-default/a.js',
      );
      let message = md`${normalizePath(
        'integration/scope-hoisting/es6/re-export-exclude-default/b.js',
        false,
      )} does not export 'default'`;

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => bundle(path.join(__dirname, source)), {
        name: 'BuildError',
        message,
        diagnostics: [
          {
            message,
            origin: '@parcel/core',
            codeFrames: [
              {
                filePath: path.join(__dirname, source),
                language: 'js',
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 8,
                    },
                    end: {
                      line: 1,
                      column: 8,
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it('throws when reexporting a missing symbol', async function () {
      let source = path.normalize(
        'integration/scope-hoisting/es6/re-export-missing/a.js',
      );
      let message = md`${normalizePath(
        'integration/scope-hoisting/es6/re-export-missing/c.js',
        false,
      )} does not export 'foo'`;
      // $FlowFixMe[prop-missing]
      await assert.rejects(() => bundle(path.join(__dirname, source)), {
        name: 'BuildError',
        message,
        diagnostics: [
          {
            message,
            origin: '@parcel/core',
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  'integration/scope-hoisting/es6/re-export-missing/b.js',
                ),
                language: 'js',
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 9,
                    },
                    end: {
                      line: 1,
                      column: 11,
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it('throws when importing a missing symbol on cached builds without changes', async function () {
      let entry = 'integration/scope-hoisting/es6/import-missing/a.js';
      let message = md`${normalizePath(
        'integration/scope-hoisting/es6/import-missing/b.js',
        false,
      )} does not export 'foo'`;
      let error = {
        name: 'BuildError',
        message,
        diagnostics: [
          {
            message,
            origin: '@parcel/core',
            codeFrames: [
              {
                filePath: path.join(__dirname, entry),
                language: 'js',
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 1,
                      column: 9,
                    },
                    end: {
                      line: 1,
                      column: 11,
                    },
                  },
                ],
              },
            ],
          },
        ],
      };

      let source = path.join(__dirname, entry);
      // $FlowFixMe[prop-missing]
      await assert.rejects(
        () =>
          bundle(source, {
            inputFS: overlayFS,
            outputFS: overlayFS,
            shouldDisableCache: false,
          }),
        error,
      );
      // $FlowFixMe[prop-missing]
      await assert.rejects(
        () =>
          bundle(source, {
            inputFS: overlayFS,
            outputFS: overlayFS,
            shouldDisableCache: false,
          }),
        error,
      );
    });

    it('supports multiple exports of the same variable', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/multi-export/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 6);
    });

    it('supports live bindings of named exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/live-bindings/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 8);
    });

    it('supports live bindings in namespaces of reexporting assets', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/live-bindings-reexports-namespace/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [1, 2]);
    });

    it('supports live bindings across bundles', async function () {
      let b = await bundle(
        ['a.html', 'b.html'].map(f =>
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/live-bindings-cross-bundle',
            f,
          ),
        ),
        {mode: 'production'},
      );

      let ctx = await runBundle(
        b,
        b.getBundles().find(b => b.type === 'html'),
        {output: null},
        {require: false},
      );
      assert.deepEqual(ctx.output, 'aaa');
    });

    it('supports live bindings of default exports', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5658
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-default-live/a.js',
        ),
      );

      let out = [];
      await run(b, {
        output(o) {
          out.push(o);
        },
      });
      assert.deepEqual(out, [5, 10]);
    });

    it('supports dynamic import syntax for code splitting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/dynamic-import/a.js',
        ),
      );

      assert.equal(await run(b), 5);
    });

    it('supports nested dynamic imports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/dynamic-import-dynamic/a.js',
        ),
      );

      assert.equal(await run(b), 123);
    });

    it('supports named exports before the variable declaration', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-before-declaration/a.js',
        ),
      );

      assert.deepEqual(await run(b), {x: 2});
    });

    it('should not export function arguments', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-binding-identifiers/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, ['test']);
    });

    it('should default export classes when wrapped', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-default-class-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output.VERSION, 1234);
    });

    it('should default export functions when wrapped', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-default-function-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output.VERSION, 1234);
    });

    it('should default export globals', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-default-global/a.js',
        ),
      );

      let Test = Symbol('Test');

      let output = await run(b, {Test});
      assert.strictEqual(output, Test);
    });

    it('should default export JS globals', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-default-js-global/a.js',
        ),
      );

      let output = await run(b);
      assert(new output([1, 2, 3]).has(1));
    });

    it('should remove export named declaration without specifiers', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/export-named-empty/a.js',
        ),
      );

      let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(!/export\s*{\s*}\s*;/.test(content));

      let output = await run(b);
      assert.strictEqual(output, 2);
    });

    it.skip('throws a meaningful error on undefined exports', async function () {
      let threw = false;
      try {
        await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/export-undefined/a.js',
          ),
        );
      } catch (err) {
        threw = true;
        assert(
          err.diagnostics[0].message.includes(
            "Export 'Test' is not defined (1:8)",
          ),
        );
      }

      assert(threw);
    });

    it('supports importing named CommonJS (export individual)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-commonjs-export-individual/a.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'c.js')))),
        new Set(['name', 'version']),
      );

      let output = await run(b);
      assert.deepEqual(output, 'name:1.2.3');
    });

    it('supports importing named CommonJS (export namespace)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-commonjs-export-object/a.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'c.js')))),
        new Set(['name', 'version']),
      );

      let output = await run(b);
      assert.deepEqual(output, 'name:1.2.3');
    });

    it('supports default importing CommonJS (export namespace)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-commonjs-export-object-default/a.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(nullthrows(findAsset(b, 'b1.js')).symbols.exportSymbols()),
        new Set(['*']),
      );

      assert.deepStrictEqual(
        new Set(nullthrows(findAsset(b, 'b2.js')).symbols.exportSymbols()),
        new Set(['*']),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        x: {foo: 1, default: 2},
        y: 4,
      });
    });

    it('supports import default CommonJS interop (export value)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-commonjs-default/a.js',
        ),
      );

      let dist = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(dist.includes('$parcel$interopDefault'));

      let output = await run(b);
      assert.deepEqual(output, 'foobar:foo:bar');
    });

    it('supports import default CommonJS interop (individual exports)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-commonjs-export-individual-default/a.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(nullthrows(findAsset(b, 'b1.js')).symbols.exportSymbols()),
        new Set(['*', 'default', 'foo']),
      );

      assert.deepStrictEqual(
        new Set(nullthrows(findAsset(b, 'b2.js')).symbols.exportSymbols()),
        new Set(['*', 'foo', 'default', '__esModule']),
      );

      assert.deepStrictEqual(
        new Set(nullthrows(findAsset(b, 'b3.js')).symbols.exportSymbols()),
        new Set(['*']),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        x: {foo: 1, default: 2},
        y: 4,
        z: 6,
      });
    });

    it('falls back when importing missing symbols from CJS', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-commonjs-missing/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, undefined);
    });

    it('does not export reassigned CommonJS exports references', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/commonjs-exports-reassign/a.js',
        ),
      );

      let [foo, bExports] = await run(b);
      assert.equal(foo, 'foobar');
      assert.equal(typeof bExports, 'object');
    });

    it('supports import default CommonJS interop with dynamic imports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/dynamic-default-interop/a.js',
        ),
      );

      assert.deepEqual(await run(b), 6);
    });

    it('supports exporting an import', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-var/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foobar');
    });

    it('supports importing from a wrapped asset', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, ['a', true]);
    });

    it('wraps an asset if any of its ancestors is wrapped, even if one is not', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/multiple-ancestors-wrap/index.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(
        contents.match(/parcelRegister\(/g).length,
        2 /* once for parent asset, once for child wrapped asset */,
      );

      let output = await run(b);
      assert.deepEqual(output, [42, 43]);
    });

    it('supports importing from a wrapped asset with multiple bailouts', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-wrapped-bailout/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, ['b', true]);
    });

    for (let shouldScopeHoist of [false, true]) {
      it(`unused and missing pseudo re-exports doesn't fail the build with${
        shouldScopeHoist ? '' : 'out'
      } scope-hoisting`, async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/re-export-pseudo/a.js',
          ),
          {defaultTargetOptions: {shouldScopeHoist}},
        );

        let {output} = await run(b, null, {require: false});
        assert.deepEqual(output, 'foo');
      });
    }

    it('supports requiring a re-exported and renamed ES6 import', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-renamed/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foobar');
    });

    it('supports requiring a re-exported and renamed ES6 import (reversed order)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-renamed2/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foobar');
    });

    it('supports requiring a re-exported and renamed ES6 namespace import', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-renamed-namespace/a.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'a.js', './b.js'))),
        new Set(['default', 'x']),
      );

      let output = await run(b);
      assert.deepEqual(output, [123, 123]);
    });

    it('supports reexporting an asset from a shared bundle inside a shared bundle', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/shared-bundle-reexport/*.html',
        ),
        {mode: 'production'},
      );
      assertBundles(b, [
        {
          type: 'html',
          assets: ['index1.html'],
        },
        {
          type: 'js',
          assets: ['index1.js'],
        },
        {
          type: 'html',
          assets: ['index2.html'],
        },
        {
          type: 'js',
          assets: ['index2.js', 'b.js'],
        },
        {
          type: 'html',
          assets: ['index3.html'],
        },
        {
          type: 'js',
          assets: ['index3.js', 'b.js'],
        },
        {
          type: 'js',
          assets: ['a.js'],
        },
      ]);
      for (let bundle of b.getBundles().filter(b => b.type === 'html')) {
        let calls = [];
        await runBundle(b, bundle, {
          call(v) {
            calls.push(v);
          },
        });
        assert.equal(calls.length, 1);
        assert(calls[0].startsWith('abcabc'));
      }
    });

    it('supports simultaneous import and re-export of a symbol', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-import/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 5 * 123);

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'e.js')))),
        new Set(['default']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'e2.js')))),
        new Set(['default']),
      );
    });

    it('supports importing a namespace from a commonjs module when code split', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-commonjs/a.js',
        ),
      );

      assert.deepEqual(await run(b), 4);
    });

    it('supports resolving a static member access on a namespace', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-static-member/a.js',
        ),
      );

      let calls = [];
      let output = await run(b, {
        sideEffect: v => {
          calls.push(v);
        },
      });
      assert.deepEqual(output, 'foofoobar');
      assert.deepEqual(calls, ['c1', 'c3']);
    });

    it('should bailout with a non-static member access on a namespace', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-static-member/b.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(
          b.getUsedSymbols(findDependency(b, 'b.js', './library/index.js')),
        ),
        new Set(['*']),
      );

      let calls = [];
      let output = await run(b, {
        sideEffect: v => {
          calls.push(v);
        },
      });
      assert.deepEqual(output, 'foo');
      assert.deepEqual(calls, ['c1', 'c2', 'c3']);
    });

    it('supports importing a namespace from a wrapped module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-wrapped/a.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('$parcel$exportWildcard'));

      let output = await run(b);
      assert.deepEqual(output, 1);
    });

    it('supports wrapped assets importing their own namespace', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-wrapped-self/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, true);
    });

    it('supports importing a namespace from a transpiled CommonJS module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-namespace-commonjs-transpiled/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        bar: 3,
        foo: 1,
      });
    });

    it('removes unused exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/tree-shaking/a.js',
        ),
        {mode: 'production'},
      );

      let output = await run(b);
      assert.deepEqual(output, 2);

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('output=2'));
      assert(!contents.includes('bar'));
    });

    it('removes unused function exports when minified', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/tree-shaking-functions/a.js',
        ),
        {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        },
      );

      let output = await run(b);
      assert.deepEqual(output, 9);

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(/output=9/.test(contents));
      assert(!/.-./.test(contents));
    });

    it('removes unused transpiled classes using terser when minified', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/tree-shaking-classes-babel/a.js',
        ),
        {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        },
      );

      let output = await run(b);
      assert.deepEqual(output, 3);

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('method'));
    });

    ['global', 'esmodule'].forEach(outputFormat => {
      let targets = {
        default: {
          outputFormat,
          distDir,
        },
      };

      describe('cross bundle tree shaking: ' + outputFormat, () => {
        it('removes unused exports across bundles', async () => {
          let b = await bundle(
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/tree-shaking-cross-bundle/a.js',
            ),
            {targets, mode: 'production'},
          );

          if (outputFormat != 'esmodule') {
            // TODO execute ESM at some point
            assert.deepEqual(await run(b), ['b1:foo', 'b2:foo']);
          }

          let contents = await outputFS.readFile(
            b.getBundles().find(b => b.name.startsWith('b1')).filePath,
            'utf8',
          );
          assert(!contents.includes('bar'));

          contents = await outputFS.readFile(
            b.getBundles().find(b => b.name.startsWith('b2')).filePath,
            'utf8',
          );
          assert(!contents.includes('bar'));
        });

        it('removes unused exports with re-exports across bundles', async () => {
          let b = await bundle(
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/tree-shaking-cross-bundle-re-export/a.js',
            ),
            {targets, mode: 'production'},
          );

          if (outputFormat != 'esmodule') {
            // TODO execute ESM at some point
            assert.deepEqual(await run(b), ['b1:foo', 'b2:foo']);
          }

          let contents = await outputFS.readFile(
            b.getBundles().find(b => b.name.startsWith('b1')).filePath,
            'utf8',
          );
          assert(!contents.includes('bar'));

          contents = await outputFS.readFile(
            b.getBundles().find(b => b.name.startsWith('b2')).filePath,
            'utf8',
          );
          assert(!contents.includes('bar'));
        });

        it('removes unused exports with wildcard re-exports across bundles', async () => {
          let b = await bundle(
            path.join(
              __dirname,
              '/integration/scope-hoisting/es6/tree-shaking-cross-bundle-re-export-wildcard/a.js',
            ),
            {targets, mode: 'production'},
          );

          if (outputFormat != 'esmodule') {
            // TODO execute ESM at some point
            assert.deepEqual(await run(b), ['b1:foo', 'b2:foo']);
          }

          let contents = await outputFS.readFile(
            b.getBundles().find(b => b.name.startsWith('b1')).filePath,
            'utf8',
          );
          assert(!contents.includes('bar'));

          contents = await outputFS.readFile(
            b.getBundles().find(b => b.name.startsWith('b2')).filePath,
            'utf8',
          );
          assert(!contents.includes('bar'));
        });
      });
    });

    describe('tree shaking dynamic imports', function () {
      it.skip('supports tree shaking statically analyzable dynamic import: destructued await assignment', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/await-assignment.js',
          ),
        );

        let output = await run(b);
        assert.deepEqual(output, ['foo', 'thing']);

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(b, 'await-assignment.js', './async.js'),
            ),
          ),
          new Set(['foo', 'thing']),
        );
        assert(b.isDependencySkipped(findDependency(b, 'async.js', './a1.js')));

        let contents = await outputFS.readFile(
          b
            .getBundles()
            .find(b => b.getMainEntry().filePath.endsWith('async.js')).filePath,
          'utf8',
        );
        assert(!contents.includes('bar'));
        assert(!contents.includes('stuff'));
      });

      it('supports tree shaking statically analyzable dynamic import: destructured await declaration', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/await-declaration.js',
          ),
          {mode: 'production'},
        );

        let output = await run(b);
        assert.deepEqual(output, ['foo', 'thing']);

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(b, 'await-declaration.js', './async.js'),
            ),
          ),
          new Set(['foo', 'thing']),
        );
        assert(b.isDependencySkipped(findDependency(b, 'async.js', './a1.js')));

        let contents = await outputFS.readFile(
          b
            .getBundles()
            .find(b => b.getMainEntry().filePath.endsWith('async.js')).filePath,
          'utf8',
        );
        assert(!contents.includes('bar'));
        assert(!contents.includes('stuff'));
      });

      it('supports tree shaking statically analyzable dynamic import: namespace await declaration', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/await-declaration-namespace.js',
          ),
          {mode: 'production'},
        );

        let output = await run(b);
        assert.deepEqual(output, ['foo', 'thing']);

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(b, 'await-declaration-namespace.js', './async.js'),
            ),
          ),
          new Set(['foo', 'thing']),
        );
        assert(b.isDependencySkipped(findDependency(b, 'async.js', './a1.js')));

        let contents = await outputFS.readFile(
          b
            .getBundles()
            .find(b => b.getMainEntry().filePath.endsWith('async.js')).filePath,
          'utf8',
        );
        assert(!contents.includes('bar'));
        assert(!contents.includes('stuff'));
      });

      it('supports tree shaking statically analyzable dynamic import: namespace await declaration bailout', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/await-declaration-namespace-bailout.js',
          ),
        );

        let output = await run(b);
        assert.deepEqual(output, {
          bar: 'bar',
          foo: 'foo',
          other: 'other',
          stuff: 'stuff',
          thing: 'thing',
        });

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(
                b,
                'await-declaration-namespace-bailout.js',
                './async.js',
              ),
            ),
          ),
          new Set(['*']),
        );
      });

      it('supports tree shaking statically analyzable dynamic import: namespace await declaration eval bailout', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/await-declaration-namespace-bailout-eval.js',
          ),
        );

        let output = await run(b);
        assert.deepEqual(output, 'thing');

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(
                b,
                'await-declaration-namespace-bailout-eval.js',
                './async.js',
              ),
            ),
          ),
          new Set(['*']),
        );
      });

      it('supports tree shaking statically analyzable dynamic import: destructured then', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/then.js',
          ),
          {mode: 'production'},
        );

        let output = await run(b);
        assert.deepEqual(output, ['foo', 'thing']);

        assert.deepStrictEqual(
          new Set(b.getUsedSymbols(findDependency(b, 'then.js', './async.js'))),
          new Set(['foo', 'thing']),
        );
        assert(b.isDependencySkipped(findDependency(b, 'async.js', './a1.js')));

        let contents = await outputFS.readFile(
          b
            .getBundles()
            .find(b => b.getMainEntry().filePath.endsWith('async.js')).filePath,
          'utf8',
        );
        assert(!contents.includes('bar'));
        assert(!contents.includes('stuff'));
      });

      it('supports tree shaking statically analyzable dynamic import: namespace then', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/then-namespace.js',
          ),
          {mode: 'production'},
        );

        let output = await run(b);
        assert.deepEqual(output, ['foo', 'thing']);

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(b, 'then-namespace.js', './async.js'),
            ),
          ),
          new Set(['foo', 'thing']),
        );
        assert(b.isDependencySkipped(findDependency(b, 'async.js', './a1.js')));

        let contents = await outputFS.readFile(
          b
            .getBundles()
            .find(b => b.getMainEntry().filePath.endsWith('async.js')).filePath,
          'utf8',
        );
        assert(!contents.includes('bar'));
        assert(!contents.includes('stuff'));
      });

      it('supports tree shaking statically analyzable dynamic import: namespace then bailout', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/then-namespace-bailout.js',
          ),
        );

        let output = await run(b);
        assert.deepEqual(output, {
          bar: 'bar',
          foo: 'foo',
          other: 'other',
          stuff: 'stuff',
          thing: 'thing',
        });

        assert.deepStrictEqual(
          new Set(
            b.getUsedSymbols(
              findDependency(b, 'then-namespace-bailout.js', './async.js'),
            ),
          ),
          new Set(['*']),
        );
      });

      it('supports tree shaking statically analyzable dynamic import: esmodule output', async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/tree-shaking-dynamic-import/then.js',
          ),
          {
            mode: 'production',
            targets: {
              default: {
                outputFormat: 'esmodule',
                distDir,
              },
            },
          },
        );

        // let output = await run(b);
        // assert.deepEqual(output, 'foo');

        assert.deepStrictEqual(
          new Set(b.getUsedSymbols(findDependency(b, 'then.js', './async.js'))),
          new Set(['foo', 'thing']),
        );
        assert(b.isDependencySkipped(findDependency(b, 'async.js', './a1.js')));

        let contents = await outputFS.readFile(
          b
            .getBundles()
            .find(b => b.getMainEntry().filePath.endsWith('async.js')).filePath,
          'utf8',
        );
        assert(!contents.includes('bar'));
        assert(!contents.includes('stuff'));
      });

      it.skip('throws an error for missing exports for dynamic import: destructured await assignment', async function () {
        let source = 'await-assignment-error.js';
        let message = `async.js does not export 'missing'`;
        await assert.rejects(
          () =>
            bundle(
              path.join(
                __dirname,
                'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
                source,
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
                        start: {
                          column: 5,
                          line: 3,
                        },
                        end: {
                          column: 11,
                          line: 3,
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

      it('throws an error for missing exports for dynamic import: destructured await declaration', async function () {
        let source = path.join(
          __dirname,
          'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
          'await-declaration-error.js',
        );
        let message = `async.js does not export 'missing'`;
        await assert.rejects(
          () =>
            bundle(
              path.join(
                __dirname,
                'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
                'await-declaration-error.js',
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
                          column: 8,
                          line: 2,
                        },
                        end: {
                          column: 14,
                          line: 2,
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

      it('throws an error for missing exports for dynamic import: namespace await declaration', async function () {
        let source = path.join(
          __dirname,
          'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
          'await-declaration-namespace-error.js',
        );
        let message = `async.js does not export 'missing'`;
        await assert.rejects(
          () =>
            bundle(
              path.join(
                __dirname,
                'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
                'await-declaration-namespace-error.js',
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
                          column: 10,
                          line: 3,
                        },
                        end: {
                          column: 19,
                          line: 3,
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

      it('throws an error for missing exports for dynamic import: destructured then', async function () {
        let source = path.join(
          __dirname,
          'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
          'then-error.js',
        );
        let message = `async.js does not export 'missing'`;
        await assert.rejects(
          () =>
            bundle(
              path.join(
                __dirname,
                'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
                'then-error.js',
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
                          column: 38,
                          line: 1,
                        },
                        end: {
                          column: 44,
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

      it('throws an error for missing exports for dynamic import: namespace then', async function () {
        let source = path.join(
          __dirname,
          'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
          'then-namespace-error.js',
        );
        let message = `async.js does not export 'missing'`;
        await assert.rejects(
          () =>
            bundle(
              path.join(
                __dirname,
                'integration/scope-hoisting/es6/tree-shaking-dynamic-import',
                'then-namespace-error.js',
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
                          column: 45,
                          line: 1,
                        },
                        end: {
                          column: 54,
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
    });

    it('keeps member expression with computed properties that are variables', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/tree-shaking-export-computed-prop/a.js',
        ),
        {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        },
      );

      let output = await run(b);
      assert.strictEqual(output[0], true);
      assert.strictEqual(typeof output[1], 'undefined');
      assert.strictEqual(output[2], true);
      assert.strictEqual(typeof output[3], 'undefined');
    });

    it('support exporting a ES6 module exported as CommonJS', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-commonjs/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foo');
    });

    it('concatenates in the correct order when re-exporting assets were excluded', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/side-effects-false-order/index.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(/\s+class\s+/.test(contents));

      let called = false;
      let output = await run(b, {
        sideEffect: () => {
          called = true;
        },
      });

      assert(!called, 'side effect called');
      assert.strictEqual(output[0], 'a');
      assert.strictEqual(output[1], 'b');
      assert(new output[3]() instanceof output[2]);
    });

    it('should support chained reexports from hybrid modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-hybrid/a.js',
        ),
      );
      let output = await run(b);
      assert.strictEqual(output, 2);
    });

    it('should support chained reexports as default from hybrid modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-default-hybrid/a.js',
        ),
      );
      let output = await run(b);
      assert.strictEqual(output, 2);
    });

    it('support chained namespace reexports of CommonJS', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/re-export-commonjs-wildcard/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foo');
    });

    it('should support assets importing themselves', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-self/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 4);
    });

    it('should support named imports on wrapped modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'bar');
    });

    it('should support unused imports of wrapped modules in different bundles', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/import-wrapped-bundle-unused/a.js',
        ),
      );

      let called = false;
      await run(b, {
        sideEffect() {
          called = true;
        },
      });
      assert(called);
    });

    it('should insert esModule flag for interop for async (or shared) bundles', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/interop-async/index.html',
        ),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: false,
          },
        },
      );

      let res = await run(b, {output: null}, {require: false});
      assert.deepEqual(await res.output, ['client', 'client', 'viewer']);
    });

    it('should enable minifier to remove unused modules despite of interopDefault', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/interop-pure/a.js',
        ),
        {
          mode: 'production',
          defaultTargetOptions: {
            shouldOptimize: true,
            sourceMaps: false,
          },
        },
      );

      let contents = await outputFS.readFileSync(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert.strictEqual(contents.trim(), '"use strict";');
    });

    it('should support the jsx pragma', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/scope-hoisting/es6/jsx-pragma/a.js'),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        children: 'Test',
        props: null,
        type: 'span',
      });
    });

    it('should not nameclash with internal variables', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/scope-hoisting/es6/name-clash/a.js'),
      );

      let output = await run(b);
      assert.deepEqual(output, 'bar');
    });

    it('supports non-identifier symbol names', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/non-identifier-symbol-name/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 1);
    });

    it('should shake pure property assignments', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/pure-assignment/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 2);

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(!contents.includes('exports.bar ='));
    });

    it('should correctly rename references to default exported classes', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/default-export-class-rename/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output.foo, 'bar');
    });

    it('should correctly rename references to a class in the class body', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/class-selfreference/a.js',
        ),
      );
      let output = await run(b);
      assert.deepEqual(output.foo, 'bar');
    });

    it('should correctly codesplit even with reexporting library index', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/codesplit-reexports/src/entry.js',
        ),
        {mode: 'production'},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: [
            'entry.js',
            'foo.js',
            'bar.js',
            'bundle-manifest.js',
            'bundle-url.js',
            'cacheLoader.js',
            'js-loader.js',
          ],
        },
        {
          type: 'js',
          assets: ['async.js', 'foo2.js', 'bar2.js'],
        },
      ]);

      let output = await run(b);
      assert.deepEqual(output, [
        [20, 30],
        [2, 3],
      ]);
    });

    it('should correctly retarget dependencies when both namespace and indvidual export are used', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/retarget-namespace-single/index.js',
        ),
      );
      let output = await run(b);
      assert.deepEqual(output, [123, 123]);
    });

    it('should correctly handle circular dependencies', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/scope-hoisting/es6/circular/a.mjs'),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'b.mjs')))),
        new Set(['foo']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'c.mjs')))),
        new Set(['run']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'b.mjs', './c.mjs'))),
        new Set(['run']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'c.mjs', './b.mjs'))),
        new Set(['foo']),
      );

      let output = await run(b);
      assert.strictEqual(output, 'c:foo');
    });

    it('should correctly handle circular dependencies (2)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/scope-hoisting/es6/circular2/a.mjs'),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'b.mjs')))),
        new Set(['run', 'foo']),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'c.mjs')))),
        new Set([]),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'b.mjs', './c.mjs'))),
        new Set(['foo']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'c.mjs', './b.mjs'))),
        new Set(['foo']),
      );

      let output = await run(b);
      assert.strictEqual(output, 'b:foo:foo');
    });

    it('should correctly handle circular dependencies (3)', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/scope-hoisting/es6/circular3/a.mjs'),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'b.mjs')))),
        new Set([]),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'c.mjs')))),
        new Set(['a']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'd.mjs')))),
        new Set([]),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'a.mjs', './b.mjs'))),
        new Set(['h']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'b.mjs', './c.mjs'))),
        new Set(['a', 'd', 'g']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'c.mjs', './d.mjs'))),
        new Set(['c', 'f']),
      );
      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(findDependency(b, 'd.mjs', './b.mjs'))),
        new Set(['b', 'e']),
      );

      let output = await run(b);
      assert.strictEqual(output, 123);
    });

    it('should handle circular dependencies with wrapped assets', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/circular-wrap/index.mjs',
        ),
      );

      let output = [];
      await run(b, {
        output(o) {
          output.push(o);
        },
      });

      assert.deepEqual(output, ['d', 'c', 'b', 'a', 'index']);
    });

    it('does not tree-shake assignments to unknown objects', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/tree-shaking-no-unknown-objects/index.js',
        ),
      );

      assert.equal(await run(b), 42);
    });

    it('can conditionally reference an imported symbol and unconditionally reference it', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/conditional-import-reference/index.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'hello');
    });

    it('can conditionally reference an imported symbol from another bundle in a case clause', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/async-interop-conditional/index.js',
        ),
      );

      let output = await run(b);
      assert.equal(await output, 42);
    });

    it('should handle TSC polyfills', async () => {
      await fsFixture(overlayFS, __dirname)`
        tsc-polyfill-es6
          library.js:
            var __polyfill = (this && this.__polyfill) || function (a) {return a;};
            export default __polyfill('es6')

          index.js:
            import value from './library';
            output = value;`;

      let b = await bundle(path.join(__dirname, 'tsc-polyfill-es6/index.js'), {
        inputFS: overlayFS,
      });
      assert.equal(await run(b), 'es6');
    });

    describe("considers an asset's closest package.json for sideEffects, not the package through which it found the asset", () => {
      it('handles redirects up the tree', async () => {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-package-redirect-up/index.js',
          ),
        );

        let result = await run(b);
        assert.strictEqual(result, 1);

        let bar = findAsset(b, 'real-bar.js');
        assert(bar);
        assert.strictEqual(bar.sideEffects, false);
      });

      it('handles redirects down the tree', async () => {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/scope-hoisting/es6/side-effects-package-redirect-down/index.js',
          ),
        );

        let result = await run(b);
        assert.strictEqual(result, 1);

        let bar = findAsset(b, 'real-bar.js');
        assert(bar);
        assert.strictEqual(bar.sideEffects, false);
      });
    });

    describe('correctly updates used symbols on changes', () => {
      it('throws after removing an export', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/update-used-symbols-remove-export',
        );

        let b = bundler(path.join(testDir, 'a.js'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
        });

        await overlayFS.mkdirp(testDir);
        await overlayFS.copyFile(
          path.join(testDir, 'b.1.js'),
          path.join(testDir, 'b.js'),
        );

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, 123);

          await overlayFS.copyFile(
            path.join(testDir, 'b.2.js'),
            path.join(testDir, 'b.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildFailure');
          let message = md`${normalizePath(
            'integration/scope-hoisting/es6/update-used-symbols-remove-export/b.js',
            false,
          )} does not export 'foo'`;
          assert.deepEqual(bundleEvent.diagnostics, [
            {
              message,
              origin: '@parcel/core',
              codeFrames: [
                {
                  filePath: path.join(testDir, 'a.js'),
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
                        column: 12,
                      },
                    },
                  ],
                },
              ],
            },
          ]);

          await overlayFS.copyFile(
            path.join(testDir, 'b.1.js'),
            path.join(testDir, 'b.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, 123);

          assert.deepStrictEqual(
            new Set(
              bundleEvent.bundleGraph.getUsedSymbols(
                findAsset(bundleEvent.bundleGraph, 'b.js'),
              ),
            ),
            new Set(['foo']),
          );
        } finally {
          await subscription.unsubscribe();
        }
      });

      it('dependency symbols change', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/update-used-symbols-dependency-symbols',
        );

        let b = bundler(path.join(testDir, 'index.js'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
        });

        await overlayFS.mkdirp(testDir);
        await overlayFS.copyFile(
          path.join(testDir, 'index.1.js'),
          path.join(testDir, 'index.js'),
        );

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [123]);

          await overlayFS.copyFile(
            path.join(testDir, 'index.2.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [123, 789]);

          assert.deepStrictEqual(
            new Set(
              bundleEvent.bundleGraph.getUsedSymbols(
                findAsset(bundleEvent.bundleGraph, 'c.js'),
              ),
            ),
            new Set(['c']),
          );

          await overlayFS.copyFile(
            path.join(testDir, 'index.1.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [123]);

          assert(!findAsset(bundleEvent.bundleGraph, 'c.js'));
        } finally {
          await subscription.unsubscribe();
        }
      });

      it('add and remove dependency (keep asset)', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/update-used-symbols-dependency-add',
        );

        let b = bundler(path.join(testDir, 'index.js'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
        });

        await overlayFS.mkdirp(testDir);
        await overlayFS.copyFile(
          path.join(testDir, 'index.1.js'),
          path.join(testDir, 'index.js'),
        );

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [123]);

          let assetC = nullthrows(findAsset(bundleEvent.bundleGraph, 'd1.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetC)),
            new Set(['a']),
          );
          assert(!findAsset(bundleEvent.bundleGraph, 'd2.js'));

          await overlayFS.copyFile(
            path.join(testDir, 'index.2.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [
            123,
            789,
            {
              d1: 1,
              d2: 2,
            },
          ]);

          assetC = nullthrows(findAsset(bundleEvent.bundleGraph, 'd1.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetC)),
            new Set(['a', 'b']),
          );
          let assetD = nullthrows(findAsset(bundleEvent.bundleGraph, 'd2.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetD)),
            new Set(['*']),
          );

          await overlayFS.copyFile(
            path.join(testDir, 'index.1.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [123]);

          assetC = nullthrows(findAsset(bundleEvent.bundleGraph, 'd1.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetC)),
            new Set(['a']),
          );
          assert(!findAsset(bundleEvent.bundleGraph, 'd2.js'));
        } finally {
          await subscription.unsubscribe();
        }
      });

      it('add and remove dependency (remove asset)', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/update-used-symbols-dependency-add',
        );

        let b = bundler(path.join(testDir, 'index.js'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
        });

        await overlayFS.mkdirp(testDir);
        await overlayFS.copyFile(
          path.join(testDir, 'index.3.js'),
          path.join(testDir, 'index.js'),
        );

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [
            789,
            {
              d1: 1,
              d2: 2,
            },
          ]);

          let assetC = nullthrows(findAsset(bundleEvent.bundleGraph, 'd1.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetC)),
            new Set(['b']),
          );
          let assetD = nullthrows(findAsset(bundleEvent.bundleGraph, 'd2.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetD)),
            new Set(['*']),
          );

          await overlayFS.copyFile(
            path.join(testDir, 'index.2.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [
            123,
            789,
            {
              d1: 1,
              d2: 2,
            },
          ]);

          assetC = nullthrows(findAsset(bundleEvent.bundleGraph, 'd1.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetC)),
            new Set(['a', 'b']),
          );
          assetD = nullthrows(findAsset(bundleEvent.bundleGraph, 'd2.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetD)),
            new Set(['*']),
          );

          await overlayFS.copyFile(
            path.join(testDir, 'index.3.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, [
            789,
            {
              d1: 1,
              d2: 2,
            },
          ]);

          assetC = nullthrows(findAsset(bundleEvent.bundleGraph, 'd1.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetC)),
            new Set(['b']),
          );
          assetD = nullthrows(findAsset(bundleEvent.bundleGraph, 'd2.js'));
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetD)),
            new Set(['*']),
          );
        } finally {
          await subscription.unsubscribe();
        }
      });

      it('add and remove dependency with inline asset', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/update-used-symbols-dependency-add-inline',
        );

        let b = bundler(path.join(testDir, 'index.js'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
        });

        await overlayFS.mkdirp(testDir);
        await overlayFS.copyFile(
          path.join(testDir, 'other.1.js'),
          path.join(testDir, 'other.js'),
        );

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          let output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, 123);

          let assetOther = nullthrows(
            findAsset(bundleEvent.bundleGraph, 'other.js'),
          );
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetOther)),
            new Set([]),
          );

          await overlayFS.copyFile(
            path.join(testDir, 'other.2.js'),
            path.join(testDir, 'other.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, 1);

          assetOther = nullthrows(
            findAsset(bundleEvent.bundleGraph, 'other.js'),
          );
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetOther)),
            new Set(['a']),
          );

          await overlayFS.copyFile(
            path.join(testDir, 'other.1.js'),
            path.join(testDir, 'other.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          output = await run(bundleEvent.bundleGraph);
          assert.deepEqual(output, 123);

          assetOther = nullthrows(
            findAsset(bundleEvent.bundleGraph, 'other.js'),
          );
          assert.deepStrictEqual(
            new Set(bundleEvent.bundleGraph.getUsedSymbols(assetOther)),
            new Set([]),
          );
          assert(!findAsset(bundleEvent.bundleGraph, 'd2.js'));
        } finally {
          await subscription.unsubscribe();
        }
      });

      it('add and remove dependency with namespace', async function () {
        let testDir = path.join(
          __dirname,
          '/integration/scope-hoisting/es6/update-used-symbols-dependency-add-namespace',
        );

        let b = bundler(path.join(testDir, 'index.html'), {
          inputFS: overlayFS,
          outputFS: overlayFS,
          mode: 'production',
        });

        await overlayFS.mkdirp(testDir);
        await overlayFS.copyFile(
          path.join(testDir, 'index.1.js'),
          path.join(testDir, 'index.js'),
        );

        let subscription = await b.watch();

        try {
          let bundleEvent = await getNextBuild(b);
          assert(bundleEvent.type === 'buildSuccess');
          let res = await run(
            bundleEvent.bundleGraph,
            {output: null},
            {require: false},
          );
          assert.deepEqual(await res.output, {akGridSize: 8});

          assert.deepStrictEqual(
            new Set(
              bundleEvent.bundleGraph.getUsedSymbols(
                findAsset(bundleEvent.bundleGraph, 'themeConstants.js'),
              ),
            ),
            new Set(['gridSize']),
          );
          assert(!findAsset(bundleEvent.bundleGraph, 'themeColors.js'));

          await overlayFS.copyFile(
            path.join(testDir, 'index.2.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          res = await run(
            bundleEvent.bundleGraph,
            {output: null},
            {require: false},
          );
          assert.deepEqual(await res.output, [
            {akGridSize: 8},
            {akEmojiSelectedBackgroundColor: '#EBECF0'},
          ]);

          assert.deepStrictEqual(
            new Set(
              bundleEvent.bundleGraph.getUsedSymbols(
                findAsset(bundleEvent.bundleGraph, 'themeConstants.js'),
              ),
            ),
            new Set(['borderRadius', 'gridSize']),
          );
          assert(!findAsset(bundleEvent.bundleGraph, 'theme.js'));
          assert(findAsset(bundleEvent.bundleGraph, 'themeColors.js'));

          await overlayFS.copyFile(
            path.join(testDir, 'index.1.js'),
            path.join(testDir, 'index.js'),
          );

          bundleEvent = await getNextBuild(b);
          assert.strictEqual(bundleEvent.type, 'buildSuccess');
          res = await run(
            bundleEvent.bundleGraph,
            {output: null},
            {require: false},
          );
          assert.deepEqual(await res.output, {akGridSize: 8});

          assert.deepStrictEqual(
            new Set(
              bundleEvent.bundleGraph.getUsedSymbols(
                findAsset(bundleEvent.bundleGraph, 'themeConstants.js'),
              ),
            ),
            new Set(['gridSize']),
          );
          assert(!findAsset(bundleEvent.bundleGraph, 'themeColors.js'));
        } finally {
          await subscription.unsubscribe();
        }
      });
    });

    it('removes functions that increment variables in object properties', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/tree-shaking-increment-object/a.js',
        ),
        {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        },
      );

      let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(!content.includes('++'));

      await run(b);
    });

    it('can import urls to raw assets', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/raw-url/index-import.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(
          b.getUsedSymbols(
            findDependency(b, 'index-import.js', 'url:./foo.png'),
          ),
        ),
        new Set(['default']),
      );

      let output = await run(b);
      assert(/foo\.[a-f0-9]+\.png$/.test(output));
    });

    it('can reexport urls to raw assets', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/es6/raw-url/index-reexport.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(
          b.getUsedSymbols(
            findDependency(b, 'index-reexport.js', './reexports'),
          ),
        ),
        new Set(['assetUrl']),
      );
      assert.deepStrictEqual(
        new Set(
          b.getUsedSymbols(findDependency(b, 'reexports.js', 'url:./foo.png')),
        ),
        new Set(['default']),
      );

      let output = await run(b);
      assert(/foo\.[a-f0-9]+\.png$/.test(output));
    });

    it('should wrap modules in shared bundles', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5659
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/shared-bundle-side-effect-order/index.js',
        ),
        {mode: 'production'},
      );

      let sideEffects = [];
      let res = await run(b, {
        sideEffect(out) {
          sideEffects.push(out);
        },
      });
      await res;
      assert.deepEqual(sideEffects, ['shared1', 'run1 1', 'shared2', 'run2 2']);
    });

    it('should ensure that modules are only executed once in shared bundles', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5659
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/shared-bundle-side-effect-duplication/index.js',
        ),
        {mode: 'production'},
      );

      let sideEffects = [];
      let res = await run(b, {
        sideEffect(out) {
          sideEffects.push(out);
        },
      });
      await res;
      assert.deepEqual(sideEffects, ['v']);
    });

    it('should error when assigning to a named import', async function () {
      let source = path.join(
        __dirname,
        'integration/scope-hoisting/es6/import-local-assign/named.js',
      );

      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message: 'Assignment to an import specifier is not allowed',
        diagnostics: [
          {
            message: 'Assignment to an import specifier is not allowed',
            origin: '@parcel/transformer-js',
            codeFrames: [
              {
                filePath: source,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 2,
                      column: 1,
                    },
                    end: {
                      line: 2,
                      column: 3,
                    },
                  },
                  {
                    message: 'Originally imported here',
                    start: {
                      line: 1,
                      column: 9,
                    },
                    end: {
                      line: 1,
                      column: 11,
                    },
                  },
                ],
              },
            ],
            hints: null,
          },
        ],
      });
    });

    it('should error when assigning to a default import', async function () {
      let source = path.join(
        __dirname,
        'integration/scope-hoisting/es6/import-local-assign/default.js',
      );

      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message: 'Assignment to an import specifier is not allowed',
        diagnostics: [
          {
            message: 'Assignment to an import specifier is not allowed',
            origin: '@parcel/transformer-js',
            codeFrames: [
              {
                filePath: source,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 2,
                      column: 1,
                    },
                    end: {
                      line: 2,
                      column: 1,
                    },
                  },
                  {
                    message: 'Originally imported here',
                    start: {
                      line: 1,
                      column: 8,
                    },
                    end: {
                      line: 1,
                      column: 8,
                    },
                  },
                ],
              },
            ],
            hints: null,
          },
        ],
      });
    });

    it('should error when assigning to a namespace import', async function () {
      let source = path.join(
        __dirname,
        'integration/scope-hoisting/es6/import-local-assign/namespace.js',
      );

      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message: 'Assignment to an import specifier is not allowed',
        diagnostics: [
          {
            message: 'Assignment to an import specifier is not allowed',
            origin: '@parcel/transformer-js',
            codeFrames: [
              {
                filePath: source,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 2,
                      column: 1,
                    },
                    end: {
                      line: 2,
                      column: 1,
                    },
                  },
                  {
                    message: 'Originally imported here',
                    start: {
                      line: 1,
                      column: 13,
                    },
                    end: {
                      line: 1,
                      column: 13,
                    },
                  },
                ],
              },
            ],
            hints: null,
          },
        ],
      });
    });

    it('should error with a destructuring assignment to a namespace import', async function () {
      let source = path.join(
        __dirname,
        'integration/scope-hoisting/es6/import-local-assign/destructure-assign.js',
      );

      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message: 'Assignment to an import specifier is not allowed',
        diagnostics: [
          {
            message: 'Assignment to an import specifier is not allowed',
            origin: '@parcel/transformer-js',
            codeFrames: [
              {
                filePath: source,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 2,
                      column: 8,
                    },
                    end: {
                      line: 2,
                      column: 10,
                    },
                  },
                  {
                    message: 'Originally imported here',
                    start: {
                      line: 1,
                      column: 9,
                    },
                    end: {
                      line: 1,
                      column: 11,
                    },
                  },
                ],
              },
            ],
            hints: null,
          },
        ],
      });
    });

    it('should error with multiple assignments to an import', async function () {
      let source = path.join(
        __dirname,
        'integration/scope-hoisting/es6/import-local-assign/multiple.js',
      );

      await assert.rejects(() => bundle(source), {
        name: 'BuildError',
        message: 'Assignment to an import specifier is not allowed',
        diagnostics: [
          {
            message: 'Assignment to an import specifier is not allowed',
            origin: '@parcel/transformer-js',
            codeFrames: [
              {
                filePath: source,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 2,
                      column: 1,
                    },
                    end: {
                      line: 2,
                      column: 3,
                    },
                  },
                  {
                    message: undefined,
                    start: {
                      line: 3,
                      column: 1,
                    },
                    end: {
                      line: 3,
                      column: 3,
                    },
                  },
                  {
                    message: 'Originally imported here',
                    start: {
                      line: 1,
                      column: 9,
                    },
                    end: {
                      line: 1,
                      column: 11,
                    },
                  },
                ],
              },
            ],
            hints: null,
          },
        ],
      });
    });

    it('should allow re-declaring __esModule interop flag', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/double-esmodule/index.js',
        ),
      );

      let res = await run(b);
      assert.deepEqual(res, 'default');
    });

    it('can dynamically import a side-effect-free reexport', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/conditional-import-side-effect-free-reexport/index.mjs',
        ),
      );

      assert.deepEqual(await run(b), 42);
    });

    it('individually exports symbols from intermediately wrapped reexports', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/export-intermediate-wrapped-reexports/index.mjs',
        ),
      );

      let res = await Promise.all(await run(b));
      assert.deepEqual(res, [42, 42]);
    });

    it('should treat type-only TypeScript modules as ESM', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/empty-ts/index.ts',
        ),
      );

      let test = await run(b);
      assert.equal(test({foo: 2}), 2);
    });

    it('should not include default when reexporting * without $parcel$exportWildcard', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/no-reexport-default/index.js',
        ),
      );

      assert.equal(await run(b), 42);
    });

    it('should not include __esModule when reexporting * without $parcel$exportWildcard', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/no-reexport-esmodule/index.js',
        ),
      );

      assert.equal(await run(b), undefined);
    });

    it('should handle interop with a re-export namespace', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/re-export-interop/a.js',
        ),
      );

      let res = await run(b);
      assert.deepEqual(res['en_US'], {
        test: 'foo',
      });
    });

    it('should prioritize named exports before re-exports (before)', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/re-export-priority/entry-a.mjs',
        ),
      );

      let res = await run(b);
      assert.equal(res, 2);
    });

    it('should prioritize named exports before re-exports (after)', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/re-export-priority/entry-b.mjs',
        ),
      );

      let res = await run(b);
      assert.equal(res, 2);
    });

    it('should prioritize named exports before re-exports in namespace (before)', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/re-export-priority/namespace-a.mjs',
        ),
      );

      let res = await run(b);
      assert.deepEqual(res, {foo: 2});
    });

    it('should prioritize named exports before re-exports in namespace (after)', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/es6/re-export-priority/namespace-b.mjs',
        ),
      );

      let res = await run(b);
      assert.deepEqual(res, {foo: 2});
    });

    it('supports constant inlining', async function () {
      let b = await bundle(
        path.join(__dirname, 'integration/inline-constants/index.js'),
        {
          mode: 'production',
          defaultTargetOptions: {
            sourceMaps: false,
          },
        },
      );

      let constants = ['BLOGGER', 'PREMIUM', 'MONTHS_IN_YEAR'];

      for (let bundle of b.getBundles()) {
        let contents = await outputFS.readFile(bundle.filePath, 'utf8');

        // Check constant export names are NOT present in the bundles
        assert(
          constants.every(constant => !contents.includes(constant)),
          `Bundle didn't inline constant values`,
        );
      }

      // Run the bundle to make sure it's valid
      await run(b);
    });

    it('supports constant inlining with shared bundles', async function () {
      let b = await bundle(
        [
          path.join(
            __dirname,
            'integration/inline-constants-shared-bundles/a.html',
          ),
          path.join(
            __dirname,
            'integration/inline-constants-shared-bundles/b.html',
          ),
        ],
        {
          mode: 'production',
          defaultTargetOptions: {
            sourceMaps: false,
          },
        },
      );

      let constants = ['BLOGGER', 'PREMIUM', 'MONTHS_IN_YEAR'];

      for (let bundle of b.getBundles()) {
        let contents = await outputFS.readFile(bundle.filePath, 'utf8');

        // Check constant export names are NOT present in the bundles
        assert(
          constants.every(constant => !contents.includes(constant)),
          `Bundle didn't inline constant values`,
        );
      }

      // Run the bundle to make sure it's valid
      await run(b);
    });
  });

  describe('commonjs', function () {
    it('should wrap when this could refer to an export', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-this/a.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );

      let wrapped = contents.includes('exports.bar()');
      assert.equal(wrapped, true);
    });

    it('supports require of commonjs modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('concats commonjs modules in the correct order', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/concat-order/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports default imports of commonjs modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/default-import/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('concats modules with inserted globals in the correct order', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/concat-order-globals/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'foobar');
    });

    it('supports named imports of commonjs modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/named-import/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports namespace imports of commonjs modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/import-namespace/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 default export of expressions', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-default-export-expression/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 default export of declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-default-export-declaration/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 default export of variables', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-default-export-variable/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 named export of declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-named-export-declaration/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 named export of variables', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-named-export-variable/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 renamed exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-renamed-export/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('supports require of es6 module re-exporting all exports from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-re-export-all/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 6);
    });

    it('supports require of es6 module re-exporting all exports from multiple modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-re-export-multiple/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 7);
    });

    it('supports re-exporting individual named exports from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-re-export-named/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 3);
    });

    it('supports re-exporting default exports from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-re-export-default/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 3);
    });

    it('supports re-exporting a namespace from another module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-re-export-namespace/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 6);
    });

    it('excludes default when re-exporting a module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-re-export-exclude-default/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {foo: 3});
    });

    it('supports hybrid ES6 + commonjs modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/es6-commonjs-hybrid/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('inserts commonjs exports object in the right place', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/export-order/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out exports access resolving if it is accessed freely (exports assign)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/exports-assign.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out exports access resolving if it is accessed freely (exports define)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/exports-define.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out exports access resolving if it is accessed freely (module.exports assign)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/module-exports-assign.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out exports access resolving if it is accessed freely (module.exports define)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/module-exports-define.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out imported exports access resolving if it is accessed freely (exports assign)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/exports-assign-entry.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out imported exports access resolving if it is accessed freely (exports define)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/exports-define-entry.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out imported exports access resolving if it is accessed freely (module.exports assign)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/module-exports-assign-entry.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out imported exports access resolving if it is accessed freely (module.exports define)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/module-exports-define-entry.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 5);
    });

    it('bails out imported exports access resolving if it is accessed freely (exports reexport)', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-access-bailout/exports-assign-reexport-entry.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [5, 5]);
    });

    it('builds commonjs modules that assigns to exports before module.exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-before-module-exports/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 42);
    });

    // TODO this should be working
    it.skip('builds commonjs modules that assigns to module.exports before exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/module-exports-before-exports/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 42);
    });

    it('should support assigning to module.exports with another export', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5782
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/module-exports-default-assignment/index.js',
        ),
      );

      let output = await run(b);
      assert.equal(output.foo, 'b');
    });

    it("doesn't insert parcelRequire for missing non-js assets", async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/missing-non-js/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 27);
    });

    it('define exports in the outermost scope', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/define-exports/a.js',
        ),
      );

      assert.deepStrictEqual(
        new Set(b.getUsedSymbols(nullthrows(findAsset(b, 'a.js')))),
        new Set(['*']),
      );

      let output = await run(b);
      assert.equal(output, 'bar');
    });

    it('supports non-identifier symbol names', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/non-identifier-symbol-name/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 1);
    });

    it('supports live bindings of named exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/live-bindings/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 8);
    });

    it('should wrap modules that use eval in a function', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-eval/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 4);
    });

    it('should wrap modules that have a top-level return', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-return/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('should remove unused exports assignments for wrapped modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-unused/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 1);
    });

    it('should hoist all vars in the scope', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-var-hoisting/a.js',
        ),
      );

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );

      assert(contents.split('f1_var').length - 1, 1);
      assert(contents.split('f2_var').length - 1, 1);
      assert(contents.split('f3_var').length - 1, 1);
      assert(contents.split('f4_var').length - 1, 1);
      assert(contents.split('c1_var').length - 1, 1);
      assert(contents.split('c2_var').length - 1, 1);
      assert(contents.split('BigIntSupported').length - 1, 4);
      assert(contents.split('inner_let').length - 1, 2);

      let output = await run(b);
      assert.equal(output, true);
    });

    it('should wrap modules that access `module` as a free variable', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-module/a.js',
        ),
      );

      assert.deepEqual((await run(b)).exports, {foo: 2});
    });

    it('should call init for wrapped modules when codesplitting', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-module-codesplit/a.js',
        ),
      );

      assert.deepEqual(await run(b), 2);
    });

    it('should wrap modules that non-statically access `module`', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-module-computed/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {foo: 2});
    });

    it('should support referencing a require in object literal shorthands when wrapped', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-module-obj-literal-require/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 1234);
    });

    it('should support typeof require when wrapped', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5883
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-typeof-require/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'c1');
    });

    it('should not rename function local variables according to global replacements', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/keep-local-function-var/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foo');
    });

    it('supports using this in arrow functions', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/this-arrow-function/a.js',
        ),
      );

      let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(content.includes('=>'));

      let output = await run(b);
      assert.strictEqual(output, 'Say other');
    });

    it('supports assigning to this as exports object', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/this-reference/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [6, undefined]);
    });

    it('supports assigning to this as exports object in wrapped module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/this-reference-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [6, undefined, 4]);
    });

    it('supports using exports self reference', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/exports-self-reference/a.js',
        ),
      );

      let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(content.includes('=>'));

      let output = await run(b);
      assert.strictEqual(output, 'Say other');
    });

    it('supports using module.exports self reference', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/module-exports-self-reference/a.js',
        ),
      );

      let content = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
      assert(content.includes('=>'));

      let output = await run(b);
      assert.strictEqual(output, 'Say other');
    });

    it('supports using module.require like require', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/module-require/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output.b, 2);
    });

    it('support url imports in wrapped modules with interop', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-interop-url-import/a.js',
        ),
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['a.js', 'b.js', 'bundle-url.js'],
        },
        {
          type: 'txt',
          assets: ['data.txt'],
        },
      ]);

      let output = await run(b);
      assert(output.endsWith('.txt'));
    });

    it('supports module object properties', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/module-object/a.js',
        ),
      );

      let entryAsset = b.getBundles()[0].getMainEntry();

      // TODO: this test doesn't currently work in older browsers since babel
      // replaces the typeof calls before we can get to them.
      let output = await run(b);
      assert.equal(output.id, b.getAssetPublicId(entryAsset));
      assert.equal(output.hot, null);
      assert.equal(output.moduleRequire, null);
      assert.equal(output.type, 'object');
      assert.deepEqual(output.exports, {});
      assert.equal(output.exportsType, 'object');
      assert.equal(output.require, 'function');
    });

    it.skip("doesn't support require.resolve calls for included assets", async function () {
      let message =
        "'require.resolve' calls for bundled modules or bundled assets aren't supported with scope hoisting";
      let source = path.join(
        __dirname,
        '/integration/scope-hoisting/commonjs/require-resolve/a.js',
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
                      line: 3,
                      column: 10,
                    },
                    end: {
                      line: 3,
                      column: 31,
                    },
                  },
                ],
              },
            ],
          },
        ],
      });
    });

    it('supports mutations of the exports object by the importer', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/mutated-exports-object-importer/index.js',
        ),
      );

      assert.deepEqual(await run(b), [43, {foo: 43}]);
    });

    it('supports mutations of the exports object by a different asset', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/mutated-exports-object-different/index.js',
        ),
      );

      assert.equal(await run(b), 43);
    });

    it('supports mutations of the exports object inside an expression', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/mutated-exports-object-expression/index.js',
        ),
      );

      assert.deepEqual(await run(b), [{foo: 3}, 3, 3]);
    });

    it('supports non-static mutations of the exports object', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5591
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/mutated-non-static-require/index.js',
        ),
      );

      assert.deepEqual(await run(b), 4);
    });

    it('supports mutations of the cjs exports by the importer from a mixed module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/mutated-exports-mixed-module/index.js',
        ),
      );

      assert.deepEqual(await run(b), [
        'CJS mutated',
        'ESM',
        {cjs: 'CJS mutated', esm: 'ESM'},
      ]);
    });

    it.skip('supports require.resolve calls for excluded modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-resolve-excluded/a.js',
        ),
      );

      let output = await run(b, {
        require: {
          resolve: () => 'my-resolved-fs',
        },
      });
      assert.deepEqual(output, 'my-resolved-fs');
    });

    it('should support assets requiring themselves', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-self/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output, 4);
    });

    it('supports requiring a re-exported ES6 import', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/re-export-var/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 'foobar');
    });

    it('supports object pattern requires', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/object-pattern/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 5);
    });

    it('eliminates CommonJS export object where possible', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/eliminate-exports/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 6);
    });

    it('supports multiple assignments in one line', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/multi-assign/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {foo: 2, bar: 2, baz: 2});
    });

    it('supports circular dependencies', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-circular/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'foo bar');
    });

    it('executes modules in the correct order', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-execution-order/a.js',
        ),
      );

      let out = [];
      await run(b, {
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'b', 'c', 'd']);
    });

    it('supports conditional requires', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-conditional/a.js',
        ),
      );

      let out = [];
      await run(b, {
        b: false,
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'd']);

      out = [];
      await run(b, {
        b: true,
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'b', 'c', 'd']);
    });

    it('supports requiring a CSS asset', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-css/a.js',
        ),
      );

      assertBundles(b, [
        {
          name: 'a.js',
          assets: ['a.js'],
        },
        {
          type: 'css',
          assets: ['b.css'],
        },
      ]);

      await run(b);
    });

    it('supports requires inside functions', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-in-function/a.js',
        ),
      );

      let out = [];
      await run(b, {
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'c', 'b']);
    });

    it('supports requires inside functions with es6 import side effects', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-in-function-import/a.js',
        ),
      );

      let out = [];
      await run(b, {
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'd', 'c', 'b']);
    });

    it('hoists import calls to the top', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-in-function-import-hoist/a.js',
        ),
      );

      let out = [];
      await run(b, {
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'd', 'c', 'b']);
    });

    it('supports requires inside functions with es6 re-export side effects', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-in-function-reexport/a.js',
        ),
      );

      let out = [];
      await run(b, {
        output(o) {
          out.push(o);
        },
      });

      assert.deepEqual(out, ['a', 'd', 'c', 'b']);
    });

    it('can bundle the node stream module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/stream-module/a.js',
        ),
      );

      let res = await run(b);
      assert.equal(typeof res.Readable, 'function');
      assert.equal(typeof res.Writable, 'function');
      assert.equal(typeof res.Duplex, 'function');
    });

    it('missing exports should be replaced with an empty object', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/empty-module/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {b: {}});
    });

    it('removes unused exports', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/tree-shaking/a.js',
        ),
        {mode: 'production'},
      );

      let output = await run(b);
      assert.deepEqual(output, 2);

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('foo'));
      assert(!contents.includes('bar'));
    });

    it('removes unused exports when assigning with a string literal', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/tree-shaking-string/a.js',
        ),
        {mode: 'production'},
      );

      let output = await run(b);
      assert.deepEqual(output, [2, 20]);

      let contents = await outputFS.readFile(
        b.getBundles()[0].filePath,
        'utf8',
      );
      assert(contents.includes('foo'));
      assert(!contents.includes('bar'));
    });

    it('supports removing an unused inline export with uglify minification', async function () {
      // Uglify does strange things to multiple assignments in a line.
      // See https://github.com/parcel-bundler/parcel/issues/1549
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/export-local/a.js',
        ),
        {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        },
      );

      let output = await run(b);
      assert.deepEqual(output, 3);
    });

    it('should support sideEffects: false', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/side-effects-false/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 9);
    });

    it('can bundle browserify-produced umd bundles', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/browserify-compat/index.js',
        ),
      );

      assert.equal(await run(b), 'foo');
    });

    it('replaces properties of require with undefined', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-extensions/index.js',
        ),
      );

      await run(b);
    });

    it('should support two aliases to the same module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-aliases/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 42);
    });

    it('should retain the correct concat order with wrapped assets', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-concat-order/a.js',
        ),
      );

      let calls = [];
      await run(b, {
        sideEffect(v) {
          calls.push(v);
        },
      });
      assert.deepStrictEqual(calls, [1, 2, 3, 4, 5, 6, 7]);
    });

    it('should support optional requires', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-optional/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 42);
    });

    it('should insert __esModule interop flag when importing from an ES module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-require-es-module/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output.__esModule, true);
      assert.equal(output.default, 2);
    });

    it('should export the same values for interop shared modules in main and child bundle', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-require-es-module-code-split/main.js',
        ),
      );

      assert.equal(await run(b), 'bar:bar');
    });

    it('should export the same values for interop shared modules in main and child bundle if shared bundle is deep nested', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-require-es-module-code-split-intermediate/main.js',
        ),
      );

      assert.equal(await run(b), 'bar:bar');
    });

    it('should not insert interop default for commonjs modules with default export', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-require-commonjs/a.js',
        ),
      );

      let output = await run(b);
      let obj = {
        test: 2,
      };
      obj.default = obj;
      assert.deepEqual(output.default, obj);
    });

    it('should add a default interop for a CJS module used in a hybrid module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-commonjs-hybrid/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('should add a default interop for a CJS module used non-statically in a hybrid module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-commonjs-hybrid-dynamic/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('should not insert default interop for wrapped CJS modules', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/interop-require-commonjs-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'default');
    });

    it('should support multiple requires in the same variable declaration', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-multiple/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'before foo middle bar after');
    });

    it('should support assigning to exports from inside a function', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/export-assign-scope/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, 2);
    });

    it('should also hoist inserted polyfills of globals', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/globals-polyfills/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, true);
    });

    it('should support wrapping array destructuring declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-destructuring-array/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [1, 2]);
    });

    it('should support wrapping object destructuring declarations', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-destructuring-object/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, [4, 2]);
    });

    it('does not tree-shake assignments to unknown objects', async () => {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/tree-shaking-no-unknown-objects/index.js',
        ),
      );

      assert.equal(await run(b), 42);
    });

    it('can conditionally reference an imported symbol and unconditionally reference it', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/conditional-import-reference/index.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 'hello');
    });

    it('supports assigning to the result of a require', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-assign/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 4);
    });

    it('supports both static and non-static exports in the same module with self-reference', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/non-static-exports/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        foo: 2,
        bar: 4,
        baz: 6,
      });
    });

    it('does not replace assignments to the exports object in the same module', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/self-reference-assignment/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output, {
        foo: {
          bar: 'bar',
        },
      });
    });

    it('replaces static require member expressions with the correct `this` context', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-member-wrapped/a.js',
        ),
      );

      let output = await run(b);
      assert.deepEqual(output(), {
        foo: 2,
        bar: 4,
      });
    });

    it('does not create a self-referencing dependency for the default symbol without an __esModule flag', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/self-reference-default/a.js',
        ),
      );

      let output = await run(b);
      assert.equal(output, 2);
    });

    it('should ensure that side effect ordering is correct in sequence expressions with require', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5606
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/commonjs/wrap-expressions/a.js',
        ),
      );

      let sideEffects = [];
      let res = await run(b, {
        sideEffect(out) {
          sideEffects.push(out);
        },
      });
      await res;
      assert.deepEqual(sideEffects, ['before', 'require', 'after']);
    });

    it('should ensure that side effect ordering is correct in binary expressions with require', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5606
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/commonjs/wrap-expressions/b.js',
        ),
      );

      let sideEffects = [];
      let res = await run(b, {
        sideEffect(out) {
          sideEffects.push(out);
        },
      });
      await res;
      assert.deepEqual(sideEffects, ['before', 'require', 'after']);
    });

    it('should ensure that side effect ordering is correct with default interop', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5662
      let b = await bundle(
        path.join(
          __dirname,
          'integration/scope-hoisting/commonjs/wrap-default-interop/index.js',
        ),
      );

      let sideEffects = [];
      let res = await run(b, {
        sideEffect(out) {
          sideEffects.push(out);
        },
      });
      await res;
      assert.deepEqual(sideEffects, ['shared', 'run1', 'async c: 123']);
    });

    it('should support non-object module.exports', async function () {
      // https://github.com/parcel-bundler/parcel/issues/5892
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/export-non-object/index.js',
        ),
      );

      await run(b, null, {strict: true});
    });

    it('should support assignment to a local variable with require', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-local-assign/basic.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [
        [{foo: 2}, {foo: 2}],
        [4, {foo: 2}],
      ]);
    });

    it('should support out of order assignment to a local variable with require', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-local-assign/in-function.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [
        [{foo: 2}, {foo: 2}],
        [4, {foo: 2}],
      ]);
    });

    it('should support assignment to a local variable with require and member expression', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-local-assign/member.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [
        [2, 2],
        [4, 2],
      ]);
    });

    it('should support assignment to a local variable with require and destructuring', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-local-assign/destructure.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [
        [2, 2],
        [4, 2],
      ]);
    });

    it('should support assignment to a local variable with require and non-static access', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-local-assign/destructure.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [
        [2, 2],
        [4, 2],
      ]);
    });

    it('should handle require as the callee in a new expression', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-new/a.js',
        ),
      );

      let output = await run(b);
      assert.strictEqual(output.foo(), 1);
    });

    it('should not update mutated destructured requires', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-non-const-export/destructure.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [2, 2]);
    });

    it('should not update mutated require members', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-non-const-export/member.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [2, 2]);
    });

    it('should update live mutated require members', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/require-non-const-export/live.js',
        ),
      );

      let outputs = [];
      await run(b, {
        output(x) {
          outputs.push(x);
        },
      });

      assert.deepEqual(outputs, [2, 3]);
    });

    it('should wrap all assets with an incoming wrapped dependency', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/scope-hoisting/commonjs/wrap-deps-circular/index.js',
        ),
      );

      assert.deepEqual(await run(b), {test: 2});
    });

    it('should handle TSC polyfills', async () => {
      await fsFixture(overlayFS, __dirname)`
        tsc-polyfill-commonjs
          library.js:
            "use strict";
            var __polyfill = (this && this.__polyfill) || function (a) {return a;};
            exports.value = __polyfill('cjs')

          index.js:
            const value = require('./library');
            output = value;
      `;

      let b = await bundle(
        path.join(__dirname, 'tsc-polyfill-commonjs/index.js'),
        {
          inputFS: overlayFS,
        },
      );

      assert.deepEqual(await run(b), {value: 'cjs'});
    });
  });

  it('should not throw with JS included from HTML', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.js', 'other.js'],
      },
    ]);

    let asset = nullthrows(findAsset(b, 'other.js'));
    assert.deepStrictEqual(
      new Set(b.getUsedSymbols(asset)),
      new Set(['default']),
    );

    let value = [];
    await run(b, {
      alert: v => value.push(v),
    });
    assert.deepEqual(value, ['other']);
  });

  it('should not throw with JS dynamic imports included from HTML', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js-dynamic/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['local.js'],
      },
    ]);

    let res = await run(b, {output: null}, {require: false});
    assert.equal(typeof res.output, 'function');
    assert.equal(await res.output(), 'Imported: foobar');
  });

  it('should include the prelude in shared entry bundles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-shared/index.html'),
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
        type: 'js',
        assets: ['index.js'],
      },
      {
        name: 'iframe.html',
        assets: ['iframe.html'],
      },
      {
        type: 'js',
        assets: ['iframe.js'],
      },
      {
        type: 'js',
        assets: ['lodash.js'],
      },
    ]);

    let sharedBundle = b
      .getBundles()
      .sort((a, b) => b.stats.size - a.stats.size)[0];
    let contents = await outputFS.readFile(sharedBundle.filePath, 'utf8');
    assert(contents.includes(`if (parcelRequire == null) {`));
  });

  it.skip('does not include prelude if child bundles are isolated', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-shared/index.js'),
    );

    let mainBundle = b.getBundles().find(b => b.name === 'index.js');
    let contents = await outputFS.readFile(mainBundle.filePath, 'utf8');
    // We wrap for other reasons now, so this is broken
    assert(!contents.includes(`if (parcelRequire == null) {`));
  });

  it('should include prelude in shared worker bundles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-shared/index.js'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
        },
      },
    );

    let sharedBundle = b
      .getBundles()
      .sort((a, b) => b.stats.size - a.stats.size)
      .find(b => b.name !== 'index.js');
    let contents = await outputFS.readFile(sharedBundle.filePath, 'utf8');
    assert(contents.includes(`if (parcelRequire == null) {`));

    let workerBundle = b.getBundles().find(b => b.name.startsWith('worker-b'));
    contents = await outputFS.readFile(workerBundle.filePath, 'utf8');
    assert(
      contents.includes(
        `importScripts("./${path.basename(sharedBundle.filePath)}")`,
      ),
    );
  });

  // Mirrors the equivalent test in javascript.js
  it('should insert global variables when needed', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/globals/scope-hoisting.js'),
    );

    let output = await run(b);
    assert.deepEqual(output(), {
      dir: 'integration/globals',
      file: 'integration/globals/index.js',
      buf: Buffer.from('browser').toString('base64'),
      global: true,
    });
  });

  it('should be able to named import a reexported namespace in an async bundle', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/scope-hoisting/es6/async-named-import-ns-reexport/index.js',
      ),
    );

    assert.deepEqual(await run(b), [42, 42, 42, 42]);
  });

  it('should not remove a binding with a used AssignmentExpression', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/scope-hoisting/es6/used-assignmentexpression/a.js',
      ),
    );

    assert.strictEqual(await run(b), 3);
  });

  it('should wrap imports inside arrow functions', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/scope-hoisting/es6/wrap-import-arrowfunction/a.js',
      ),
    );

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(contents.includes('=>'));

    let calls = [];
    let output = await run(b, {
      sideEffect(id) {
        calls.push(id);
      },
    });
    assert.deepEqual(calls, []);
    assert.equal(typeof output, 'function');
    assert.deepEqual(await output(), {default: 1234});
    assert.deepEqual(calls, ['async']);
  });

  it('can static import and dynamic import in the same bundle without creating a new bundle', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/sync-async/same-bundle-scope-hoisting.js',
      ),
      {mode: 'production'},
    );

    assertBundles(b, [
      {
        name: 'same-bundle-scope-hoisting.js',
        assets: [
          'same-bundle-scope-hoisting.js',
          'get-dep.js',
          'get-dep-2.js',
          'dep.js',
        ],
      },
    ]);

    assert.deepEqual(await await run(b), [42, 42, 42]);
  });

  it('can static import and dynamic import in the same bundle ancestry without creating a new bundle', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/sync-async/same-ancestry-scope-hoisting.js',
      ),
      {mode: 'production'},
    );

    assertBundles(b, [
      {
        name: 'same-ancestry-scope-hoisting.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'dep.js',
          'js-loader.js',
          'same-ancestry-scope-hoisting.js',
        ],
      },
      {
        assets: ['get-dep.js'],
      },
    ]);

    assert.deepEqual(await run(b), [42, 42]);
  });

  it('loads another bundle from a dynamic import with a shared dependency only when necessary', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/sync-async-when-needed/index.js'),
      {mode: 'production'},
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'index.js',
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {assets: ['dep.js']},
      {
        assets: ['async-has-dep.js', 'dep.js', 'get-dep.js'],
      },
      {assets: ['get-dep.js']},
    ]);

    assert.deepEqual(await run(b), [42, 42]);
  });

  it('can static import and dynamic import in the same bundle when another bundle requires async', async () => {
    let b = await bundle(
      ['same-bundle-scope-hoisting.js', 'get-dep-scope-hoisting.js'].map(
        entry => path.join(__dirname, '/integration/sync-async/', entry),
      ),
      {mode: 'production'},
    );

    assertBundles(b, [
      {
        assets: ['dep.js'],
      },
      {
        name: 'same-bundle-scope-hoisting.js',
        assets: [
          'same-bundle-scope-hoisting.js',
          'get-dep.js',
          'get-dep-2.js',
          'dep.js',
        ],
      },
      {
        name: 'get-dep-scope-hoisting.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'get-dep-scope-hoisting.js',
          'js-loader.js',
        ],
      },
    ]);

    let bundles = b.getBundles();
    let sameBundle = bundles.find(
      b => b.name === 'same-bundle-scope-hoisting.js',
    );
    let getDep = bundles.find(b => b.name === 'get-dep-scope-hoisting.js');

    assert.deepEqual(await runBundle(b, sameBundle), [42, 42, 42]);
    assert.deepEqual(await runBundle(b, getDep), 42);
  });

  it("can share dependencies between a shared bundle and its sibling's descendants", async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/shared-exports-for-sibling-descendant/scope-hoisting.js',
      ),
      {mode: 'production'},
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
        name: 'scope-hoisting.js',
        assets: [
          'bundle-manifest.js',
          'bundle-url.js',
          'cacheLoader.js',
          'scope-hoisting.js',
          'js-loader.js',
        ],
      },
    ]);

    assert.deepEqual(await run(b), [3, 5]);
  });

  it('deduplicates shared sibling assets between bundle groups', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/shared-sibling-scope-hoist/index.js'),
    );

    assert.deepEqual(await run(b), ['a', 'b', 'c']);
  });

  it('can run an entry bundle whose entry asset is present in another bundle', async () => {
    let b = await bundle(
      ['index.js', 'value.js'].map(basename =>
        path.join(__dirname, '/integration/sync-entry-shared', basename),
      ),
      {targets: {main: {context: 'node', distDir, isLibrary: true}}},
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {name: 'value.js', assets: ['value.js']},
      {assets: ['async.js']},
    ]);

    assert.equal(await (await run(b)).default, 43);
  });

  it('can run an async bundle whose entry asset is present in another bundle', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/async-entry-shared/scope-hoisting.js'),
    );

    assertBundles(b, [
      {
        name: 'scope-hoisting.js',
        assets: [
          'scope-hoisting.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
        ],
      },
      {assets: ['value.js']},
      {assets: ['async.js']},
    ]);

    assert.deepEqual(await run(b), [42, 43]);
  });

  it('can run an async bundle that depends on a nonentry asset in a sibling', async () => {
    let b = await bundle(
      ['scope-hoisting.js', 'other-entry.js'].map(basename =>
        path.join(
          __dirname,
          '/integration/async-entry-shared-sibling',
          basename,
        ),
      ),
    );

    assertBundles(b, [
      {
        name: 'scope-hoisting.js',
        assets: [
          'scope-hoisting.js',
          'bundle-url.js',
          'cacheLoader.js',
          'js-loader.js',
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
      {assets: ['a.js', 'value.js']},
      {assets: ['b.js']},
    ]);

    assert.deepEqual(await run(b), 43);
  });

  it('correctly updates dependencies when a specifier is added', async function () {
    let testDir = path.join(
      __dirname,
      '/integration/scope-hoisting/es6/cache-add-specifier',
    );

    let b = bundler(path.join(testDir, 'a.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
    });

    let subscription = await b.watch();

    let bundleEvent = await getNextBuild(b);
    assert(bundleEvent.type === 'buildSuccess');
    let output = await run(bundleEvent.bundleGraph);
    assert.deepEqual(output, 'foo');

    await overlayFS.mkdirp(testDir);
    await overlayFS.copyFile(
      path.join(testDir, 'a.1.js'),
      path.join(testDir, 'a.js'),
    );

    bundleEvent = await getNextBuild(b);
    assert(bundleEvent.type === 'buildSuccess');
    output = await run(bundleEvent.bundleGraph);
    assert.deepEqual(output, 'foobar');

    await subscription.unsubscribe();
  });

  it('should not rewrite this in arrow function class properties', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-class-this-esm/a.js'),
    );
    let res = await run(b);
    assert.deepEqual(res, 'x: 123');
  });

  it('should call named imports without this context', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/js-import-this/index.js'),
    );
    let res = await run(b, {output: null}, {strict: true});
    assert.deepEqual(res, {
      unwrappedNamed: [true, false],
      unwrappedDefault: [true, false],
      // TODO: unwrappedNamespace should actually be `[false, true]` but we optimize
      // the `ns.foo` expression into a named import, so that namespace isn't available anymore.
      unwrappedNamespace: [true, false],
      wrappedNamed: [true, false],
      wrappedDefault: [true, false],
      wrappedNamespace: [false, true],
    });
  });

  it('should insert the prelude for sibling bundles referenced in HTML', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/scope-hoisting/es6/sibling-dependencies/index.html',
      ),
    );
    let res = await run(b, {output: null}, {require: false});
    assert.equal(res.output, 'a');
  });

  it('should unmark dependency as deferred when dependency becomes used', async function () {
    let testDir = path.join(
      __dirname,
      'integration/scope-hoisting/es6/unmarks-defer-for-new-deps',
    );

    let packageDir = path.join(testDir, '/package');

    await overlayFS.mkdirp(packageDir);
    await overlayFS.copyFile(
      path.join(packageDir, 'b1.js'),
      path.join(packageDir, 'b.js'),
    );

    await bundle(path.join(testDir, 'index.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
      shouldDisableCache: true,
    });

    await overlayFS.copyFile(
      path.join(packageDir, 'b2.js'),
      path.join(packageDir, 'b.js'),
    );

    await bundle(path.join(testDir, 'index.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
      shouldDisableCache: false,
    });
  });

  it('unmark an asset group as deferred when it becomes used', async function () {
    let testDir = path.join(
      __dirname,
      'integration/scope-hoisting/es6/unmarks-defer-for-assetgroup',
    );

    await overlayFS.mkdirp(testDir);
    await overlayFS.copyFile(
      path.join(testDir, 'index1.js'),
      path.join(testDir, 'index.js'),
    );

    let b = await bundle(path.join(testDir, 'index.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
      shouldDisableCache: true,
    });

    assert.strictEqual(await run(b), 'bar');

    await overlayFS.copyFile(
      path.join(testDir, 'index2.js'),
      path.join(testDir, 'index.js'),
    );

    b = await bundle(path.join(testDir, 'index.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
      shouldDisableCache: false,
    });

    assert.strictEqual(await run(b), 'bar foo');

    await overlayFS.copyFile(
      path.join(testDir, 'index3.js'),
      path.join(testDir, 'index.js'),
    );

    b = await bundle(path.join(testDir, 'index.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
      shouldDisableCache: false,
    });

    assert.strictEqual(await run(b), 'bar foo bar');
  });

  it("not insert unused requires that aren't registered anywhere", async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/scope-hoisting/es6/unused-require/index.js',
      ),
    );

    let output = await run(b);
    assert.strictEqual(output, 'foo');
  });

  it('produce the same bundle hash regardless of transformation order', async function () {
    let testDir = path.join(
      __dirname,
      'integration/scope-hoisting/es6/non-deterministic-bundle-hashes',
    );

    const waitHandler = (fileToDelay, fileToWaitFor) => {
      const waitMap = new Map();

      function wait(filePath) {
        if (waitMap.has(filePath)) {
          return Promise.resolve();
        }
        return new Promise(resolve => {
          waitMap.set(filePath, resolve);
        });
      }
      // a set of filepaths that have been read
      function seen(filePath) {
        // check map of things we're waiting for to resolved promises
        let promisesToResolve = waitMap.get(filePath);
        if (promisesToResolve) {
          // if we find any, we call it
          promisesToResolve();
        }
        waitMap.set(filePath, null);
      }

      return {
        get(target, prop) {
          let original = Reflect.get(...arguments);
          if (prop === 'readFile') {
            return async function (...args) {
              if (args[0].includes(fileToDelay)) {
                await wait(fileToWaitFor);
              }
              let result = await original.apply(this, args);
              seen(path.basename(args[0]));
              return result;
            };
          }
          return original;
        },
      };
    };

    let workerFarm = createWorkerFarm({
      maxConcurrentWorkers: 0,
    });

    let slowFooFS = new Proxy(overlayFS, waitHandler('foo.js', 'bar.js'));

    try {
      let b = await bundle(path.join(testDir, 'index.html'), {
        inputFS: slowFooFS,
        outputFS: slowFooFS,
        shouldDisableCache: true,
        workerFarm,
      });

      let bundleHashDelayFoo = b
        .getBundles()
        .find(b => b.filePath.endsWith('.js') && b.filePath.includes('index'))
        .filePath.split('.')[1];

      let slowBarFS = new Proxy(overlayFS, waitHandler('bar.js', 'foo.js'));

      let b2 = await bundle(path.join(testDir, 'index.html'), {
        inputFS: slowBarFS,
        outputFS: slowBarFS,
        shouldDisableCache: true,
        workerFarm,
      });

      let bundleHashDelayBar = b2
        .getBundles()
        .find(b => b.filePath.endsWith('.js') && b.filePath.includes('index'))
        .filePath.split('.')[1];

      assert.strictEqual(bundleHashDelayFoo, bundleHashDelayBar);
    } finally {
      await workerFarm.end();
    }

    it('should not deduplicate an asset if it will become unreachable', async function () {
      let b = await bundle(
        path.join(
          __dirname,
          'integration/sibling-deduplicate-unreachable/index.js',
        ),
        {mode: 'production'},
      );
      let res = await run(b);
      assert.equal(res, 'target');
    });
  });

  it('should add experimental bundle queue runtime for out of order bundle execution', async function () {
    await fsFixture(overlayFS, __dirname)`
      bundle-queue-runtime
        a.html:
          <script type="module" src="./a.js"></script>
        a.js:
          export default 'a';

        b.js:
          export default 'b';

        c.js:
          export default 'c';

        index.html:
          <script type="module" src="./index.js"></script>
        index.js:
          import a from './a';
          import b from './b';
          import c from './c';

          result([a, b, c]);

        package.json:
          {
              "@parcel/bundler-default": {
                  "minBundleSize": 0
              },
              "@parcel/packager-js": {
                  "unstable_asyncBundleRuntime": true
              }
          }
        yarn.lock:`;

    let b = await bundle(
      [
        path.join(__dirname, 'bundle-queue-runtime/index.html'),
        path.join(__dirname, 'bundle-queue-runtime/a.html'),
      ],
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
          outputFormat: 'esmodule',
        },
        inputFS: overlayFS,
      },
    );

    let contents = await outputFS.readFile(
      b.getBundles().find(b => /index.*\.js/.test(b.filePath)).filePath,
      'utf8',
    );
    assert(contents.includes('$parcel$global.rwr('));

    let result;
    await run(b, {
      result: r => {
        result = r;
      },
    });

    assert.deepEqual(await result, ['a', 'b', 'c']);
  });

  it('should add experimental bundle queue runtime to manual shared bundles', async function () {
    await fsFixture(overlayFS, __dirname)`
      bundle-queue-runtime
        index.html:
          <script type="module" src="./index.js"></script>
        shared.js:
          export default 'shared';
        index.js:
          import shared from './shared';
          result(['index', shared]);

        package.json:
          {
              "@parcel/bundler-default": {
                  "minBundleSize": 0,
                  "manualSharedBundles": [{
                    "name": "shared",
                    "types": ["js"],
                    "assets": ["shared.js"]
                  }]
              },
              "@parcel/packager-js": {
                  "unstable_asyncBundleRuntime": true
              }
          }
        yarn.lock:`;

    let b = await bundle(
      [path.join(__dirname, 'bundle-queue-runtime/index.html')],
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
          outputFormat: 'esmodule',
        },
        inputFS: overlayFS,
      },
    );
    function hasAsset(bundle, assetName) {
      let result = false;

      bundle.traverseAssets(asset => {
        if (asset.filePath.includes(assetName)) {
          result = true;
        }
      });

      return result;
    }
    let sharedBundleContents = await outputFS.readFile(
      nullthrows(
        b.getBundles().find(b => hasAsset(b, 'shared.js')),
        'No shared bundle',
      ).filePath,
      'utf8',
    );
    let entryContents = await outputFS.readFile(
      nullthrows(
        b.getBundles().find(b => hasAsset(b, 'index.js')),
        'No entry bundle',
      ).filePath,
      'utf8',
    );

    assert(
      sharedBundleContents.includes('$parcel$global.rlb('),
      'Shared bundle should include register loaded bundle runtime',
    );

    assert(
      entryContents.includes('$parcel$global.rwr('),
      'Entry should include run when ready runtime',
    );

    let result;
    await run(b, {
      result: r => {
        result = r;
      },
    });

    assert.deepEqual(await result, ['index', 'shared']);
  });

  it('should not add experimental bundle queue runtime to empty bundles', async function () {
    await fsFixture(overlayFS, __dirname)`
      bundle-queue-runtime
        empty.js:
          // Just a comment
        package.json:
          {
             "@parcel/packager-js": {
                  "unstable_asyncBundleRuntime": true
              }
          }
        yarn.lock:`;

    let b = await bundle(
      [path.join(__dirname, 'bundle-queue-runtime/empty.js')],
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
          outputFormat: 'esmodule',
        },
        inputFS: overlayFS,
      },
    );

    let contents = await outputFS.readFile(
      nullthrows(b.getBundles().find(b => /empty.*\.js/.test(b.filePath)))
        .filePath,
      'utf8',
    );

    assert(
      !contents.includes('$parcel$global.rlb('),
      "Empty bundle should not include 'runLoadedBundle' code",
    );

    try {
      await run(b);
    } catch (e) {
      assert.fail('Expected the empty bundle to still run');
    }
  });
});
