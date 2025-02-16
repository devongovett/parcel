import assert from 'assert';
import {
  bundle,
  assertBundles,
  removeDistDirectory,
  distDir,
  inputFS,
  outputFS,
  overlayFS,
  ncp,
} from '@parcel/test-utils';
import path from 'path';
import {
  NodePackageManager,
  MockPackageInstaller,
} from '@parcel/package-manager';

describe('posthtml', function () {
  afterEach(async () => {
    await removeDistDirectory();
  });

  it('should support transforming HTML with posthtml', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/posthtml/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(path.join(distDir, 'index.html'));
    assert(html.includes('<h1>Other page</h1>'));
  });

  it('should find assets inside posthtml', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/posthtml-assets/index.html'),
    );

    assertBundles(b, [
      {
        type: 'html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);
  });

  it.skip('Should be able to process an html file with plugins without any params for plugin', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/posthtml-plugins/index.html'),
    );

    assertBundles(b, [
      {
        type: 'html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf-8',
    );
    assert(
      html.includes(
        '&#115;&#97;&#109;&#64;&#115;&#109;&#105;&#116;&#104;&#46;&#99;&#111;&#109;',
      ),
    );
    assert(!html.includes('sam@smith.com'));
  });

  it.skip('should add dependencies referenced by posthtml-include', async () => {
    const b = await bundle(
      path.join(__dirname, '/integration/posthtml-assets/index.html'),
    );
    const asset = b.assets.values().next().value;
    const other = path.join(
      __dirname,
      '/integration/posthtml-assets/other.html',
    );
    assert(asset.dependencies.has(other));
    assert(asset.dependencies.get(other).includedInParent);
  });

  it.skip('should add dependencies referenced by plugins', async () => {
    const b = await bundle(
      path.join(__dirname, '/integration/posthtml-plugin-deps/index.html'),
    );
    const asset = b.assets.values().next().value;
    const other = path.join(
      __dirname,
      '/integration/posthtml-plugin-deps/base.html',
    );
    assert(asset.dependencies.has(other));
    assert(asset.dependencies.get(other).includedInParent);
  });

  it('should automatically install posthtml plugins if needed', async () => {
    let inputDir = path.join(__dirname, '/input');
    await outputFS.rimraf(inputDir);
    await ncp(
      path.join(__dirname, '/integration/posthtml-autoinstall'),
      inputDir,
    );

    let packageInstaller = new MockPackageInstaller();
    packageInstaller.register(
      'posthtml-test',
      inputFS,
      path.join(__dirname, '/integration/posthtml-autoinstall/posthtml-test'),
    );

    // The package manager uses an overlay filesystem, which performs writes to
    // an in-memory fs and reads first from memory, then falling back to the real fs.
    let packageManager = new NodePackageManager(
      overlayFS,
      inputDir,
      packageInstaller,
    );

    let distDir = path.join(outputFS.cwd(), 'dist');

    await bundle(path.join(__dirname, '/input/index.html'), {
      inputFS: overlayFS,
      packageManager,
      shouldAutoInstall: true,
      defaultTargetOptions: {
        distDir,
      },
    });

    // posthtml-test was installed
    let pkg = JSON.parse(
      await outputFS.readFile(
        path.join(__dirname, '/input/package.json'),
        'utf8',
      ),
    );
    assert(pkg.devDependencies['posthtml-test']);

    // posthtml-test is applied
    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('<span id="test">Test</span>'));
  });
});
