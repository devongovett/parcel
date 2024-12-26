import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  assertBundles,
  distDir,
  outputFS,
  overlayFS,
  fsFixture,
} from '@parcel/test-utils';

describe('sass', function () {
  it('should support requiring sass files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/sass/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.index'));
  });

  it('should support requiring scss files', async function () {
    let b = await bundle(path.join(__dirname, '/integration/scss/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.scss'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.index'));
  });

  it('should support scss imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/scss-import/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.scss'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.index'));
    assert(css.includes('.foo'));
    assert(css.includes('.bar'));
  });

  it('should support scss imports in html for >1 target', async function () {
    //Repro copied from https://github.com/parcel-bundler/parcel/issues/8754
    let b = await bundle(path.join(__dirname, '/integration/scss-html-import'));

    assertBundles(b, [
      {
        name: 'target1.html',
        assets: ['target1.html'],
      },
      {
        assets: ['style.scss'],
      },
      {
        name: 'target2.html',
        assets: ['target2.html'],
      },
      {
        assets: ['style.scss'],
      },
      {
        assets: ['fa-regular-400.ttf'],
      },
      {
        assets: ['fa-regular-400.ttf'],
      },
    ]);
  });

  it('should support requiring empty scss files', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/scss-empty/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.scss'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert.equal(css.trim(), '/*# sourceMappingURL=index.css.map */');
  });

  it('should support linking to assets with url() from scss', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/scss-url/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        type: 'jpeg',
        assets: ['image.jpeg'],
      },
      {
        name: 'index.css',
        assets: ['index.scss'],
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
    assert(/url\("test\.[0-9a-f]+\.woff2"\)/.test(css));
    assert(css.includes('url("http://google.com")'));
    assert(css.includes('.index'));

    assert(
      await outputFS.exists(
        path.join(distDir, css.match(/url\("(test\.[0-9a-f]+\.woff2)"\)/)[1]),
      ),
    );
  });

  it('should support transforming scss with postcss', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/scss-postcss/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'index.module.scss'],
      },
      {
        name: 'index.css',
        assets: ['index.module.scss'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    let className = output();
    assert.notStrictEqual(className, 'index');

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes(`.${className}`));
  });

  it('should support advanced import syntax', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/sass-advanced-import/index.sass'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let css = (
      await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8')
    ).replace(/\s+/g, ' ');
    assert(css.includes('.foo { color: pink;'));
    assert(css.includes('.bar { color: green;'));
  });

  it('should support absolute imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/scss-absolute-imports/style.scss'),
    );

    assertBundles(b, [
      {
        name: 'style.css',
        assets: ['style.scss'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'style.css'), 'utf8');
    assert(css.includes('.a'));
    assert(css.includes('.b'));
  });

  it('should merge global data property from .sassrc.js', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/scss-global-data/index.scss'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.scss'],
      },
    ]);

    let css = (
      await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8')
    ).replace(/\s+/g, ' ');
    assert(css.includes('.a { color: red;'));
  });

  it('should support using the custom webpack/sass node_modules syntax', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/sass-webpack-import-error/index.sass'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.external'));
  });

  it('should support node_modules imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/sass-node-modules-import/index.sass'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.external'));
  });

  it('should support imports from includePaths (legacy)', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/sass-include-paths-import/index.sass'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.included'));
  });

  it('should support imports from loadPaths (modern)', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/sass-load-paths-import/index.sass'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.included'));
  });

  it('should support package.json exports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/sass-exports/index.sass'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.sass'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.external'));
  });

  it('should import from packages with a string key of `sass` in package.json', async function () {
    const dir = path.join(__dirname, 'sass-package-import-edge-case');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      index.js:
        import './main.css';

      main.css:
        @import './edge/main.scss'

      edge
        package.json:
          {
            "name": "edge",
            "sass": "main.scss"
          }

        main.scss:
          .foo {
            .bar {
              color: green;
            }
          }
        `;

    let b = await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
    });

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['main.css', 'main.scss'],
      },
    ]);
  });

  it('should support sass import resolution rules', async function () {
    const dir = path.join(__dirname, 'sass-extensions');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      index.js:
        import './main.scss';

      main.scss:
        @use '~test' as test;

      node_modules/test/package.json:
        { "name": "test" }

      node_modules/test/_index.scss:
        @use 'other';

      node_modules/test/_other.scss:
        .foo { color: red }
      `;

    await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
    });
  });

  it('should support npm scheme', async function () {
    const dir = path.join(__dirname, 'sass-extensions');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      index.js:
        import './main.scss';

      main.scss:
        @use 'npm:test' as test;

      node_modules/test/package.json:
        { "name": "test" }

      node_modules/test/_index.scss:
        @use 'other';

      node_modules/test/_other.scss:
        .foo { color: red }
      `;

    await bundle(path.join(dir, '/index.js'), {
      inputFS: overlayFS,
    });
  });
});
