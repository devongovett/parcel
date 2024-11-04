// @flow
import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  assertBundles,
  distDir,
  removeDistDirectory,
  inputFS,
  outputFS,
} from '@parcel/test-utils';

describe('css', () => {
  afterEach(async () => {
    await removeDistDirectory();
  });

  it('should produce two bundles when importing a CSS file', async () => {
    let b = await bundle(path.join(__dirname, '/integration/css/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js', 'local.js', 'c.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css', 'local.css', 'c.css'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert.ok(css.indexOf('.c {') < css.indexOf('.local {'));
    assert.ok(css.indexOf('.local {') < css.indexOf('.index {'));
  });

  it('should bundle css dependencies in the correct, postorder traversal order', async () => {
    let b = await bundle(path.join(__dirname, '/integration/css-order/a.css'));

    // Given a tree of css with imports:
    //      A
    //    /   \
    //   B     E
    //  / \
    // C   D
    //
    // (A imports B (which imports C and D) and E)
    //
    // ...styles should be applied in the order C, D, B, E, A

    assertBundles(b, [
      {
        name: 'a.css',
        assets: ['a.css', 'b.css', 'c.css', 'd.css', 'e.css'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'a.css'), 'utf8');
    assert.ok(
      css.indexOf('.c {') < css.indexOf('.d {') &&
        css.indexOf('.d {') < css.indexOf('.b {') &&
        css.indexOf('.b {') < css.indexOf('.e {') &&
        css.indexOf('.e {') < css.indexOf('.a {'),
    );
  });
  it('should place one css bundle per bundlegroup for naming reasons', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/multi-css-bug/src/entry.js'),
    );

    assertBundles(b, [
      {
        name: 'entry.js',
        type: 'js',
        assets: ['bundle-url.js', 'cacheLoader.js', 'entry.js', 'js-loader.js'],
      },
      {
        type: 'js',
        assets: ['esmodule-helpers.js', 'index.js'],
      },
      {name: 'entry.css', type: 'css', assets: ['foo.css', 'main.css']},
    ]);
  });
  it.skip('create a new css bundle to maintain one css bundle per bundlegroup constraint', async () => {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/multi-css-multi-entry-bug/src/entry.js',
      ),
    );

    assertBundles(b, [
      {
        name: 'entry.js',
        type: 'js',
        assets: [
          'bundle-url.js',
          'cacheLoader.js',
          'css-loader.js',
          'entry.js',
          'js-loader.js',
        ],
      },
      {
        type: 'js',
        assets: ['esmodule-helpers.js', 'index.js'],
      },
      {name: 'Foo.css', type: 'css', assets: ['foo.css']},
      {name: 'entry.css', type: 'css', assets: ['foo.css', 'main.css']},
    ]);
  });
  it('should support loading a CSS bundle along side dynamic imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/dynamic-css/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: [
          'bundle-url.js',
          'cacheLoader.js',
          'css-loader.js',
          'index.js',
          'js-loader.js',
        ],
      },
      {name: /local\.[0-9a-f]{8}\.js/, assets: ['local.js']},
      {name: /local\.[0-9a-f]{8}\.css/, assets: ['local.css']},
      {name: 'index.css', assets: ['index.css']},
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(await output(), 3);
  });

  it('should support importing CSS from a CSS file', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/css-import/index.js'),
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css', 'other.css', 'local.css'],
      },
    ]);

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = await outputFS.readFile(path.join(distDir, '/index.css'), 'utf8');
    assert(css.includes('.local'));
    assert(css.includes('.other'));
    assert(
      /@media print {\s*\.local(.|\n)*\.other(.|\n)*}(.|\n)*\.index/.test(css),
    );
    assert(css.includes('.index'));
  });

  it('should support linking to assets with url() from CSS', async function () {
    let b = await bundle(path.join(__dirname, '/integration/css-url/index.js'));

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css'],
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
    assert(css.includes('url("data:image/gif;base64,quotes")'));
    assert(css.includes('.quotes'));
    assert(css.includes('url("data:image/gif;base64,no-quote")'));
    assert(css.includes('.no-quote'));

    assert(
      await outputFS.exists(
        path.join(distDir, css.match(/url\("(test\.[0-9a-f]+\.woff2)"\)/)[1]),
      ),
    );
  });

  it('should support linking to assets with url() from CSS in production', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/css-url/index.js'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
      {
        name: 'index.css',
        assets: ['index.css'],
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
    assert(/url\(test\.[0-9a-f]+\.woff2\)/.test(css), 'woff ext found in css');
    assert(css.includes('url(http://google.com)'), 'url() found');
    assert(css.includes('.index'), '.index found');
    assert(/url\("?data:image\/gif;base64,quotes"?\)/.test(css));
    assert(css.includes('.quotes'));
    assert(/url\("?data:image\/gif;base64,no-quote"?\)/.test(css));
    assert(css.includes('.no-quote'));

    assert(
      await outputFS.exists(
        path.join(distDir, css.match(/url\((test\.[0-9a-f]+\.woff2)\)/)[1]),
      ),
    );
  });

  it('should support linking to assets in parent folders with url() from CSS', async function () {
    let b = await bundle(
      [
        path.join(__dirname, '/integration/css-url-relative/src/a/style1.css'),
        path.join(__dirname, '/integration/css-url-relative/src/b/style2.css'),
      ],
      {
        defaultTargetOptions: {
          shouldOptimize: true,
          sourceMaps: false,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['style1.css'],
      },
      {
        type: 'css',
        assets: ['style2.css'],
      },
      {
        type: 'png',
        assets: ['foo.png'],
      },
    ]);

    let cssPath = path.join(distDir, 'a', 'style1.css');
    let css = await outputFS.readFile(cssPath, 'utf8');

    assert(css.includes('background-image'), 'includes `background-image`');
    assert(/url\([^)]*\)/.test(css), 'includes url()');

    assert(
      await outputFS.exists(
        path.resolve(path.dirname(cssPath), css.match(/url\(([^)]*)\)/)[1]),
      ),
      'path specified in url() exists',
    );
  });

  it('should handle quote in CSS URL correctly', async function () {
    await bundle(path.join(__dirname, '/integration/css-url-quote/index.css'));

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');

    assert(
      css.includes(
        'url("data:image/svg+xml;utf8,with quote \\" and escape \\\\");',
      ),
    );
  });

  it('should ignore url() with IE behavior specifiers', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/css-url-behavior/index.css'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.css'],
      },
    ]);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');

    assert(css.includes('url("#default#VML")'));
  });

  it('should throw a diagnostic for relative url() dependencies in custom properties', async function () {
    let fixture = path.join(
      __dirname,
      'integration/css-url-custom-property/index.css',
    );
    let code = await inputFS.readFileSync(fixture, 'utf8');
    // $FlowFixMe
    await assert.rejects(
      () =>
        bundle(fixture, {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message:
              "Ambiguous url('foo.png') in custom property. Relative paths are resolved from the location the var() is used, not where the custom property is defined. Use an absolute URL instead",
            origin: '@parcel/transformer-css',
            name: 'SyntaxError',
            stack: undefined,
            codeFrames: [
              {
                filePath: fixture,
                code,
                codeHighlights: [
                  {
                    start: {
                      line: 2,
                      column: 11,
                    },
                    end: {
                      line: 2,
                      column: 11,
                    },
                  },
                ],
              },
            ],
            hints: [
              'Replace with: url(/integration/css-url-custom-property/foo.png)',
            ],
            documentationURL: 'https://parceljs.org/languages/css/#url()',
          },
        ],
      },
    );
  });

  it('should minify CSS when minify is set', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/cssnano/index.js'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
          sourceMaps: false,
        },
      },
    );

    let output = await run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 3);

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.local'));
    assert(css.includes('.index'));

    assert.equal(css.split('\n').length, 1);
  });

  it('should produce a sourcemap when sourceMaps are used', async function () {
    await bundle(path.join(__dirname, '/integration/cssnano/index.js'), {
      defaultTargetOptions: {
        shouldOptimize: true,
      },
    });

    let css = await outputFS.readFile(path.join(distDir, 'index.css'), 'utf8');
    assert(css.includes('.local'));
    assert(css.includes('.index'));

    let lines = css.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(lines[1], '/*# sourceMappingURL=index.css.map */');

    let map = JSON.parse(
      await outputFS.readFile(path.join(distDir, 'index.css.map'), 'utf8'),
    );
    assert.equal(map.file, 'index.css.map');
    assert(map.sources.includes('integration/cssnano/local.css'));
    assert(map.sources.includes('integration/cssnano/index.css'));
  });

  it('should inline data-urls for text-encoded files', async () => {
    await bundle(path.join(__dirname, '/integration/data-url/text.css'), {
      defaultTargetOptions: {
        sourceMaps: false,
      },
    });
    let css = await outputFS.readFile(path.join(distDir, 'text.css'), 'utf8');
    assert.equal(
      css.trim(),
      `.svg-img {
  background-image: url("data:image/svg+xml,%3Csvg%20width%3D%22120%22%20height%3D%22120%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Cfilter%20id%3D%22blur-_.%21~%2a%22%3E%0A%20%20%20%20%3CfeGaussianBlur%20stdDeviation%3D%225%22%3E%3C%2FfeGaussianBlur%3E%0A%20%20%3C%2Ffilter%3E%0A%20%20%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2250%22%20fill%3D%22green%22%20filter%3D%22url%28%27%23blur-_.%21~%2a%27%29%22%3E%3C%2Fcircle%3E%0A%3C%2Fsvg%3E%0A");
}`,
    );
  });

  it('should inline data-urls for binary files', async () => {
    await bundle(path.join(__dirname, '/integration/data-url/binary.css'));
    let css = await outputFS.readFile(path.join(distDir, 'binary.css'), 'utf8');
    assert(
      css.startsWith(`.webp-img {
  background-image: url("data:image/webp;base64,UklGR`),
    );
  });

  it('should remap locations in diagnostics using the input source map', async () => {
    let fixture = path.join(
      __dirname,
      'integration/diagnostic-sourcemap/index.scss',
    );
    let code = await inputFS.readFileSync(fixture, 'utf8');
    // $FlowFixMe
    await assert.rejects(
      () =>
        bundle(fixture, {
          defaultTargetOptions: {
            shouldOptimize: true,
          },
        }),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: "Failed to resolve 'x.png' from './index.scss'",
            origin: '@parcel/core',
            codeFrames: [
              {
                filePath: fixture,
                code,
                codeHighlights: [
                  {
                    message: undefined,
                    start: {
                      line: 5,
                      column: 3,
                    },
                    end: {
                      line: 5,
                      column: 3,
                    },
                  },
                ],
              },
            ],
          },
          {
            message: "Cannot load file './x.png' in './'.",
            origin: '@parcel/resolver-default',
            hints: [],
          },
        ],
      },
    );
  });

  it('should support importing CSS from node_modules with the npm: scheme', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/css-node-modules/index.css'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.css', 'foo.css'],
      },
    ]);
  });

  it('should support the style package exports condition', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/css-exports/index.css'),
    );

    assertBundles(b, [
      {
        name: 'index.css',
        assets: ['index.css', 'foo.css'],
      },
    ]);
  });

  it('should support external CSS imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/css-external/a.css'),
    );

    assertBundles(b, [
      {
        name: 'a.css',
        assets: ['a.css', 'b.css'],
      },
    ]);

    let res = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      new RegExp(`@import "http://example.com/external.css";
.b {
  color: red;
}\n?
.a {
  color: green;
}`).test(res),
    );
  });

  it('should support css nesting with lightningcss', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/css-nesting/a.css'),
      {
        defaultTargetOptions: {
          engines: {
            browsers: 'chrome 80',
          },
        },
      },
    );

    let res = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(res.includes('.foo.bar'));
  });

  it('should support @layer', async function () {
    let b = await bundle(path.join(__dirname, '/integration/css-layer/a.css'), {
      mode: 'production',
    });

    let res = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      res.includes(
        '@layer b.c{.c{color:#ff0}}@layer b{.b{color:#00f}}.a{color:red}',
      ),
    );
  });
});
