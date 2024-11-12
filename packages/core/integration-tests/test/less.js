import assert from 'assert';
import path from 'path';
import {
  assertBundles,
  bundle,
  distDir,
  outputFS,
  run,
} from '@parcel/test-utils';
import {md} from '@parcel/diagnostic';

describe('less', function () {
  it('should support requiring less files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/less/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.index'));
  });

  it('should support less imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-import/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.a'));
    assert(css.includes('.b'));
    assert(css.includes('.c'));
    assert(css.includes('.d'));
  });

  it('should support advanced less imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-advanced-import/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');

    assert(css.includes('.a'));
    assert(css.includes('.external-index'));
    assert(css.includes('.external-a'));
    assert(css.includes('.external-with-main'));
    assert(css.includes('.explicit-external-a'));
  });

  it('should support requiring empty less files', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-empty/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert.equal(css.trim(), '/*# sourceMappingURL=index.css.map */');
  });

  it('should support linking to assets with url() from less', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-url/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
      {
        type: 'woff2',
        assets: ['test.woff2'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(/url\("?test\.[0-9a-f]+\.woff2"?\)/.test(css));
    assert(/url\("?http:\/\/google.com"?\)/.test(css));
    assert(css.includes('.index'));

    assert(
      await outputFS.exists(
        path.join(distDir, css.match(/url\("?(test\.[0-9a-f]+\.woff2)"?\)/)[1]),
      ),
    );
  });

  it('should support less url rewrites', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-url-rewrite/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
      {
        type: 'woff2',
        assets: ['a.woff2'],
      },
      {
        type: 'woff2',
        assets: ['b.woff2'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.a'));
    assert(css.includes('.b'));
  });

  it('should support css modules in less', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-postcss/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'index.module.less'],
      },
      {
        name: 'index.css',
        assets: ['index.module.less'],
      },
      {
        assets: ['img.svg'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert(output().endsWith('_index'));

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(/\.[_0-9a-zA-Z]+_index/.test(css));
  });

  it('should throw an exception when using webpack syntax', async function () {
    await assert.rejects(
      () =>
        bundle(
          path.join(
            __dirname,
            '/integration/less-webpack-import-error/index.js',
          ),
        ),
      {
        message: md`The @import path "${'~library/style.less'}" is using webpack specific syntax, which isn't supported by Parcel.\n\nTo @import files from ${'node_modules'}, use "${'library/style.less'}"`,
      },
    );
  });

  it('should support configuring less include paths', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-include-paths/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.a'));
    assert(css.includes('.b'));
  });

  it('should ignore url() with IE behavior specifiers', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/less-url-behavior/index.less'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');

    assert(css.includes('url("#default#VML")'));
  });

  it('preserves quotes around data urls that require them', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/less-url-quotes/index.less'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.less'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(
      css.includes(
        // Note the literal space after "xml"
        'background: url("data:image/svg+xml,%3C%3Fxml version%3D%221.0%22%3F%3E%3Csvg%3E%3C%2Fsvg%3E")',
      ),
    );
  });

  it('should support the less package exports condition', async function () {
    await bundle(path.join(__dirname, '/integration/less-exports/index.less'));

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.a'));
  });
});
