// @flow
import assert from 'assert';
import path from 'path';
import url from 'url';
import nullthrows from 'nullthrows';
import {
  assertBundles,
  bundle,
  distDir,
  outputFS,
  run,
} from '@parcel/test-utils';

const tscConfig = path.join(
  __dirname,
  '/integration/typescript-config/.parcelrc',
);

describe('typescript', function () {
  // This tests both the SWC transformer implementation of typescript (which
  // powers typescript by default in Parcel) as well as through the Typescript
  // tsc transformer. Use a `undefined` config to indicate the default config, and the
  // tsc config to use the tsc transformer instead.
  //
  // If testing details specific to either implementation, create another suite.
  for (let config of [
    undefined /* default config -- testing SWC typescript */,
    tscConfig,
  ]) {
    it('should produce a ts bundle using ES6 imports', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'Local.ts', 'esmodule-helpers.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);
    });

    it('should produce a ts bundle using commonJS require', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-require/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'Local.ts', 'esmodule-helpers.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);
    });

    it('should support json require', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-json/index.ts'),
      );

      // assert.equal(b.assets.size, 2);
      // assert.equal(b.childBundles.size, 1);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);
    });

    it('should support env variables', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-env/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'esmodule-helpers.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.env, 'function');
      assert.equal(output.env(), 'test');
    });

    it('should support importing a URL to a raw asset', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-raw/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.ts', 'bundle-url.js', 'esmodule-helpers.js'],
        },
        {
          type: 'txt',
          assets: ['test.txt'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.getRaw, 'function');
      assert(/http:\/\/localhost\/test\.[0-9a-f]+\.txt$/.test(output.getRaw()));
      assert(
        await outputFS.exists(
          path.join(distDir, nullthrows(url.parse(output.getRaw()).pathname)),
        ),
      );
    });

    it('should minify with minify enabled', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-require/index.ts'),
        {
          config,
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        },
      );

      assertBundles(b, [
        {
          type: 'js',
          assets: ['index.ts', 'Local.ts', 'esmodule-helpers.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.count, 'function');
      assert.equal(output.count(), 3);

      let js = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
      assert(!js.includes('local.a'));
    });

    it('should support compiling JSX', async function () {
      await bundle(
        path.join(__dirname, '/integration/typescript-jsx/index.tsx'),
        {config},
      );

      let file = await outputFS.readFile(
        path.join(distDir, 'index.js'),
        'utf8',
      );
      assert(file.includes('React.createElement("div"'));
    });

    it('should use esModuleInterop by default', async function () {
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-interop/index.ts'),
        {config},
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['esmodule-helpers.js', 'index.ts', 'commonjs-module.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(typeof output.test, 'function');
      assert.equal(output.test(), 'test passed');
    });

    it('fs.readFileSync should inline a file as a string', async function () {
      if (config != null) {
        return;
      }
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-fs/index.ts'),
        {config},
      );

      const text = 'export default <div>Hello</div>;';
      let output = await run(b);

      assert.deepEqual(output, {
        fromTs: text,
        fromTsx: text,
      });
    });

    it('should handle legacy cast in .ts file', async function () {
      if (config != null) {
        return;
      }
      await bundle(
        path.join(__dirname, '/integration/typescript-legacy-cast/index.ts'),
        {config},
      );
    });

    it('should handle compile enums correctly', async function () {
      if (config != null) {
        return;
      }
      let b = await bundle(
        path.join(__dirname, '/integration/typescript-enum/index.ts'),
        {config},
      );

      let output = await run(b);

      assert.deepEqual(output, {
        A: {
          X: 'X',
          Y: 'Y',
        },
        B: {
          X: 'X',
          Y: 'Y',
        },
        C: {
          X: 'X',
          Y: 'Y',
        },
        z: {
          a: 'X',
          c: 'Y',
        },
      });
    });

    it('should handle simultaneous import type and reexport correctly', async function () {
      if (config != null) {
        return;
      }
      let b = await bundle(
        path.join(
          __dirname,
          '/integration/typescript-import-type-reexport/index.ts',
        ),
        {config},
      );

      let output = await run(b);

      assert.deepEqual(output, {
        Bar: 123,
      });
    });
  }
});
