// @flow
import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  runBundle,
  overlayFS,
  outputFS,
  fsFixture,
  assertBundles,
} from '@parcel/test-utils';
import nullthrows from 'nullthrows';

describe('library bundler', function () {
  let count = 0;
  let dir;
  beforeEach(async () => {
    dir = path.join(__dirname, 'libraries', '' + ++count);
    await overlayFS.mkdirp(dir);
  });

  after(async () => {
    await overlayFS.rimraf(path.join(__dirname, 'libraries'));
  });

  it('should support named imports', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "main": "dist/main.js",
          "module": "dist/module.js",
          "engines": { "node": "*" }
        }

      index.js:
        export * from './foo';
        export {bar} from './bar';

      foo.js:
        import {baz} from './baz';
        export function foo() {
          return 'foo' + baz();
        }

      bar.js:
        import {baz} from './baz';
        export function bar() {
          return 'bar' + baz();
        }

      baz.js:
        export function baz() {
          return 'baz';
        }
    `;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
      mode: 'production',
    });

    let esm: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'module.js')),
    );
    assert.equal(esm.foo(), 'foobaz');
    assert.equal(esm.bar(), 'barbaz');

    let cjs: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'main.js')),
    );
    assert.equal(cjs.foo(), 'foobaz');
    assert.equal(cjs.bar(), 'barbaz');

    assertBundles(b, [
      {
        assets: ['index.js'],
      },
      {
        assets: ['foo.js'],
      },
      {
        assets: ['bar.js'],
      },
      {
        assets: ['baz.js'],
      },
      {
        assets: ['index.js'],
      },
      {
        assets: ['foo.js'],
      },
      {
        assets: ['bar.js'],
      },
      {
        assets: ['baz.js'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(!contents.includes('parcelRequire'));
      if (bundle.env.outputFormat === 'esmodule') {
        assert(contents.includes('export {'));
      } else if (bundle.env.outputFormat === 'commonjs') {
        assert(contents.includes('module.exports'));
      }
    }
  });

  it('should merge multiple assets in the same file together', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "module": "dist/module.js"
        }

      index.js:
        export {foo, bar} from './foo';

      foo.js:
        import {css} from './macro' with {type: 'macro'};
        export function foo() {
          return css('.a { color: red }');
        }

        export function bar() {
          return css('.b { color: pink }');
        }

      macro.js:
        export function css(content) {
          this.addAsset({type: 'css', content});
          return 'hi';
        }
    `;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
      mode: 'production',
    });

    assertBundles(b, [
      {
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['foo.js'],
      },
      {
        type: 'css',
        assets: ['foo.js', 'foo.js'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(!contents.includes('parcelRequire'));
      if (bundle.type === 'css') {
        assert(contents.includes('.a'));
        assert(contents.includes('.b'));
      } else {
        assert(contents.includes('export {'));
        if (bundle.name === 'module.js') {
          // Should only include shallow bundle references.
          assert(!contents.includes('.css'));
        }
      }
    }
  });

  it('should work with CSS modules', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "module": "dist/module.js",
          "main": "dist/main.js",
          "engines": { "node": "*" }
        }

      index.js:
        import foo from './foo.module.css';
        export function test() {
          return foo.bar;
        }

      foo.module.css:
        .bar {
          color: red;
        }
    `;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
      mode: 'production',
    });

    assertBundles(b, [
      {
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['foo.module.css'],
      },
      {
        type: 'css',
        assets: ['foo.module.css'],
      },
      {
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['foo.module.css'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(!contents.includes('parcelRequire'));
      if (bundle.type === 'css') {
        assert(contents.includes('.Qe6WCq_bar'));
      } else if (bundle.env.outputFormat === 'esmodule') {
        assert(contents.includes('export {'));
      } else if (bundle.env.outputFormat === 'commonjs') {
        assert(contents.includes('module.exports'));
      }
    }

    let esm: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'module.js')),
    );
    assert.equal(esm.test(), 'Qe6WCq_bar');

    let cjs: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'main.js')),
    );
    assert.equal(cjs.test(), 'Qe6WCq_bar');
  });

  it('should support re-exporting external modules', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "module": "dist/module.js",
          "main": "dist/main.js",
          "engines": { "node": "*" },
          "targets": {
            "module": {
              "includeNodeModules": false
            },
            "main": {
              "includeNodeModules": false
            }
          },
          "dependencies": {
            "bar": "*"
          }
        }

      index.js:
        export {foo} from './foo.js';
        export {bar} from 'bar';

      foo.js:
        export function foo() {
          return 'foo';
        }
    `;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
      mode: 'production',
    });

    assertBundles(b, [
      {
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['foo.js'],
      },
      {
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['foo.js'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(!contents.includes('parcelRequire'));
      if (bundle.env.outputFormat === 'esmodule') {
        assert(contents.includes('export {'));
      } else if (bundle.env.outputFormat === 'commonjs') {
        assert(contents.includes('module.exports'));
      }
    }

    let esm: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'module.js')),
      null,
      undefined,
      {
        bar() {
          return {bar: () => 2};
        },
      },
    );
    assert.equal(esm.foo(), 'foo');
    assert.equal(esm.bar(), 2);

    let cjs: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'main.js')),
      null,
      undefined,
      {
        bar() {
          return {bar: () => 2};
        },
      },
    );
    assert.equal(cjs.foo(), 'foo');
    assert.equal(cjs.bar(), 2);
  });

  it('should export CJS namespaces as default', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "module": "dist/module.js",
          "engines": { "node": "*" }
        }

      index.js:
        import ns from './foo.js';
        export function test() {
          return ns['foo-bar'];
        }

      foo.js:
        exports['foo-bar'] = 'foo';
    `;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
      mode: 'production',
    });

    assertBundles(b, [
      {
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['foo.js'],
      },
    ]);

    let res = await run(b);
    assert.equal(res.test(), 'foo');

    // foo.js should only export default, to avoid non-identifier symbols.
    let foo: any = await runBundle(b, b.getBundles()[1]);
    assert.deepEqual(Object.keys(foo), ['default']);
    assert.deepEqual(foo.default, {'foo-bar': 'foo'});
  });

  it('should allow bundles to be reused between targets in the same package', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "engines": { "node": "*" },
          "targets": {
            "a": {
              "source": "src/a.js",
              "distDir": "a",
              "outputFormat": "esmodule",
              "isLibrary": true
            },
            "b": {
              "source": "src/b.js",
              "distDir": "b",
              "outputFormat": "esmodule",
              "isLibrary": true
            }
          }
        }

      src/a.js:
        import shared from './shared';
        export default shared + '-a';

      src/b.js:
        import shared from './shared';
        export default shared + '-b';

      src/shared.js:
        export default 'shared';
    `;

    let b = await bundle(dir, {
      inputFS: overlayFS,
      mode: 'production',
    });

    assertBundles(b, [
      {
        assets: ['a.js'],
      },
      {
        assets: ['b.js'],
      },
      {
        assets: ['shared.js'],
      },
    ]);

    let res: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'a.js')),
    );

    assert.equal(res.default, 'shared-a');

    let res2: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'b.js')),
    );

    assert.equal(res2.default, 'shared-b');
  });

  it('should not share bundles with circular references in different targets', async function () {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      packages/a/package.json:
        {
          "engines": { "node": "*" },
          "source": "src/a.js",
          "module": "dist/a.js",
          "targets": {
            "module": {
              "includeNodeModules": true
            }
          }
        }

      packages/a/src/a.js:
        import shared from '/shared.module.css';
        export default shared.foo + '-a';

      packages/b/package.json:
        {
          "engines": { "node": "*" },
          "source": "src/b.js",
          "module": "dist/b.js",
          "targets": {
            "module": {
              "includeNodeModules": true
            }
          }
        }

      packages/b/src/b.js:
        import shared from '/shared.module.css';
        export default shared.foo + '-b';

      shared.module.css:
        .foo {
          composes: bar;
          color: white
        }

        .bar { background: pink }
    `;

    let b = await bundle(dir + '/packages/*', {
      inputFS: overlayFS,
      mode: 'production',
    });

    assertBundles(b, [
      {
        assets: ['a.js'],
      },
      {
        assets: ['b.js'],
      },
      {
        type: 'js',
        assets: ['shared.module.css'],
      },
      {
        type: 'js',
        assets: ['shared.module.css'],
      },
      {
        type: 'css',
        assets: ['shared.module.css'],
      },
      {
        type: 'css',
        assets: ['shared.module.css'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(!contents.includes('../'));
    }
  });

  it('should support export default in CJS', async () => {
    await fsFixture(overlayFS, dir)`
      yarn.lock:

      .parcelrc:
        {
          "extends": "@parcel/config-default",
          "bundler": "@parcel/bundler-library"
        }

      package.json:
        {
          "module": "dist/module.js",
          "main": "dist/main.js",
          "engines": { "node": "*" }
        }

      index.js:
        import foo from './foo';
        export function test() {
          return 'test:' + foo();
        }

      foo.js:
        export default function foo() {
          return 'foo';
        }
    `;

    let b = await bundle(dir + '/index.js', {
      inputFS: overlayFS,
      mode: 'production',
    });

    let esm: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'module.js')),
    );
    assert.equal(esm.test(), 'test:foo');

    let cjs: any = await runBundle(
      b,
      nullthrows(b.getBundles().find(b => b.name === 'main.js')),
    );
    assert.equal(cjs.test(), 'test:foo');
  });
});
