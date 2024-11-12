// @flow
import assert from 'assert';
import path from 'path';
import {
  assertBundles,
  bundle,
  distDir,
  outputFS,
  run,
} from '@parcel/test-utils';

const config = path.join(__dirname, '/integration/typescript-config/.parcelrc');

describe('typescript tsc', function () {
  it('should support loading tsconfig.json', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/typescript-config/index.ts'),
      {config},
    );

    let output = await run(b);
    assert.equal(output, 2);

    let js = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(!js.includes('/* test comment */'));
  });

  it('should support loading tsconfig.json with extends', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/typescript-config-extends/index.ts'),
      {config},
    );

    let output = await run(b);
    assert.equal(output, 2);

    let js = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(!js.includes('/* test comment */'));
  });

  it('should produce a type declaration file when overriding the ts pipeline', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/typescript-types-parcelrc/index.ts'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.ts'],
      },
      {
        name: 'index.d.ts',
        assets: ['index.ts'],
      },
    ]);

    let output = await run(b);
    assert.equal(new output.Foo().run(), 'bar');
  });
});
