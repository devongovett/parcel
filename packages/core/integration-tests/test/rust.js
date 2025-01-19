import assert from 'assert';
import path from 'path';
import {
  bundle,
  bundler,
  run,
  assertBundleTree,
  outputFS,
} from '@parcel/test-utils';
import commandExists from 'command-exists';

describe.skip('rust', function () {
  if (typeof WebAssembly === 'undefined' || !commandExists.sync('rustup')) {
    // eslint-disable-next-line no-console
    console.log(
      'Skipping Rust tests. Install https://www.rustup.rs/ to run them.',
    );
    return;
  }

  it('should generate a wasm file from a rust file with rustc with --target=browser', async function () {
    this.timeout(500000);
    let b = await bundle(path.join(__dirname, '/integration/rust/index.js'));

    await assertBundleTree(b, {
      name: 'index.js',
      assets: ['bundle-loader.js', 'index.js', 'wasm-loader.js'],
      childBundles: [
        {
          type: 'wasm',
          assets: ['add.rs'],
          childBundles: [],
        },
        {
          type: 'map',
        },
      ],
    });

    var res = await await run(b);
    assert.equal(res, 5);

    // not minified
    assert(
      (await outputFS.stat(Array.from(b.childBundles)[0].name)).size > 500,
    );
  });

  it('should generate a wasm file from a rust file with rustc with --target=node', async function () {
    this.timeout(500000);
    let b = await bundle(path.join(__dirname, '/integration/rust/index.js'), {
      target: 'node',
    });

    await assertBundleTree(b, {
      name: 'index.js',
      assets: ['bundle-loader.js', 'index.js', 'wasm-loader.js'],
      childBundles: [
        {
          type: 'wasm',
          assets: ['add.rs'],
          childBundles: [],
        },
        {
          type: 'map',
        },
      ],
    });

    var res = await run(b);
    assert.equal(res, 5);

    // not minified
    assert(
      (await outputFS.stat(Array.from(b.childBundles)[0].name)).size > 500,
    );
  });

  it('should support rust files with dependencies via rustc', async function () {
    this.timeout(500000);
    let b = bundler(path.join(__dirname, '/integration/rust-deps/index.js'));
    let bundle = await b.bundle();

    await assertBundleTree(bundle, {
      name: 'index.js',
      assets: ['bundle-loader.js', 'index.js', 'wasm-loader.js'],
      childBundles: [
        {
          type: 'map',
        },
        {
          type: 'wasm',
          assets: ['test.rs'],
          childBundles: [],
        },
      ],
    });

    var res = await run(bundle);
    assert.equal(res, 10);
  });

  it('should generate a wasm file from a rust file with cargo', async function () {
    this.timeout(500000);
    let b = await bundle(
      path.join(__dirname, '/integration/rust-cargo/src/index.js'),
    );

    await assertBundleTree(b, {
      name: 'index.js',
      assets: ['bundle-loader.js', 'index.js', 'wasm-loader.js'],
      childBundles: [
        {
          type: 'map',
        },
        {
          type: 'wasm',
          assets: ['lib.rs'],
          childBundles: [],
        },
      ],
    });

    var res = await run(b);
    assert.equal(res, 5);
  });

  it('should generate a wasm file from a rust file in cargo workspace', async function () {
    this.timeout(500000);
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/rust-cargo-workspace/member/src/index.js',
      ),
    );

    await assertBundleTree(b, {
      name: 'index.js',
      assets: ['bundle-loader.js', 'index.js', 'wasm-loader.js'],
      childBundles: [
        {
          type: 'map',
        },
        {
          type: 'wasm',
          assets: ['lib.rs'],
          childBundles: [],
        },
      ],
    });

    var res = await run(b);
    assert.equal(res, 5);
  });
});
