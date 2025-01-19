import assert from 'assert';
import {
  assertBundles,
  bundle,
  bundler,
  distDir,
  getNextBuild,
  removeDistDirectory,
  run,
  inputFS,
  outputFS,
  overlayFS,
  ncp,
  fsFixture,
} from '@parcel/test-utils';
import path from 'path';
import Logger from '@parcel/logger';
import {md} from '@parcel/diagnostic';

describe('html', function () {
  beforeEach(async () => {
    await removeDistDirectory();
  });

  let subscription;
  afterEach(async () => {
    if (subscription) {
      await subscription.unsubscribe();
      subscription = null;
    }
  });

  it('should support bundling HTML', async () => {
    let b = await bundle(path.join(__dirname, '/integration/html/index.html'));

    assertBundles(b, [
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        // index.html
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        // foo/index.html
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        // other.html
        name: 'other.html',
        assets: ['other.html'],
      },
      {
        // foo/other.html
        name: 'other.html',
        assets: ['other.html'],
      },
      {
        type: 'svg',
        assets: ['icons.svg'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
      {
        type: 'css',
        assets: ['index.css'],
      },
    ]);

    let files = await outputFS.readdir(distDir);
    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    for (let file of files) {
      if (file !== 'index.html' && path.extname(file) !== '.map') {
        assert(html.includes(file));
      }
    }

    assert(html.includes('#hash_link'));
    assert(html.includes('mailto:someone@acme.com'));
    assert(html.includes('tel:+33636757575'));
    assert(html.includes('https://unpkg.com/parcel-bundler'));

    let iconsBundle = b.getBundles().find(b => b.name.startsWith('icons'));
    assert(
      html.includes('/' + path.basename(iconsBundle.filePath) + '#icon-code'),
    );

    let value = null;
    await run(b, {
      alert: v => (value = v),
    });
    assert.equal(value, 'Hi');
  });

  it('should support pkg#source array as entrypoints', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/html-pkg-source-array'),
    );

    assertBundles(b, [
      {
        name: 'a.html',
        assets: ['a.html'],
      },
      {
        name: 'b.html',
        assets: ['b.html'],
      },
    ]);

    assert(await outputFS.exists(path.join(distDir, 'a.html'), 'utf8'));
    assert(await outputFS.exists(path.join(distDir, 'b.html'), 'utf8'));
  });

  it('should find href attr when not first', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-attr-order/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'html',
        assets: ['other.html'],
      },
    ]);
  });

  it('should insert empty script tag for HMR at the end of the body', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/html-no-js/index.html'),
      {
        hmrOptions: {},
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    const html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    assert(/<script src=".+?\.js"><\/script><\/body>/.test(html));
  });

  it('should insert empty script tag for HMR at the implied </body>', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/html-no-js/no-body.html'),
      {
        hmrOptions: {},
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['no-body.html'],
      },
      {
        name: 'no-body.html',
        assets: ['no-body.html'],
      },
    ]);

    const html = await outputFS.readFile(
      path.join(distDir, 'no-body.html'),
      'utf8',
    );

    assert(/<script src=".+?\.js"><\/script><\/html>/.test(html));
  });

  it('should insert empty script tag for HMR at the end of the file if both </body> and </html> are implied', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/html-no-js/no-body-or-html.html'),
      {
        hmrOptions: {},
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['no-body-or-html.html'],
      },
      {
        name: 'no-body-or-html.html',
        assets: ['no-body-or-html.html'],
      },
    ]);

    const html = await outputFS.readFile(
      path.join(distDir, 'no-body-or-html.html'),
      'utf8',
    );

    assert(/<script src=".+?\.js"><\/script>$/.test(html));
  });

  it('should insert empty script tag for HMR at the end of the body when having normal inline script', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/html-inline-js/index.html'),
      {
        hmrOptions: {},
      },
    );

    assertBundles(b, [
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {name: 'index.html', assets: ['index.html']},
    ]);

    const html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    assert(/<script src=".+?\.js"><\/script><\/body>/.test(html));
  });

  it('should support canonical links', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-canonical/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    assert(/<link rel="canonical" href="\.?\/index.html">/.test(html));
  });

  it('should support RSS feed links', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-feed/rss.html'),
    );

    assertBundles(b, [
      {
        name: 'rss.html',
        assets: ['rss.html'],
      },
      {
        name: 'feed.xml',
        assets: ['feed.xml'],
      },
    ]);
  });

  it('should support atom feed links', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-feed/atom.html'),
    );

    assertBundles(b, [
      {
        name: 'atom.html',
        assets: ['atom.html'],
      },
      {
        name: 'feed.xml',
        assets: ['feed.xml'],
      },
    ]);
  });

  it('should support meta tags', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-meta/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        name: 'logo.svg',
        assets: ['logo.svg'],
      },
      {
        type: 'png',
        assets: ['logo.png'],
      },
      {
        type: 'png',
        assets: ['logo.png'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes(`<meta name="msapplication-config" content="none">`));
    assert(html.includes(`<meta property="og:image" content="/logo.svg">`));
    assert(
      /<meta name="msapplication-TileImage" content="\/logo\.[0-9a-f]+\.png">/.test(
        html,
      ),
    );
    assert(
      /<meta name="msapplication-square70x70logo" content="\/logo\.[0-9a-f]+\.png">/.test(
        html,
      ),
    );
    assert(
      html.includes(
        `<meta name="twitter:image" content="https://parceljs.org/assets/logo.svg">`,
      ),
    );
  });

  it('should insert sibling CSS bundles for JS files in the HEAD', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-css/index.html'),
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
        type: 'css',
        assets: ['index.css'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(
      /<link rel="stylesheet" href="[/\\]{1}index\.[a-f0-9]+\.css">/.test(html),
    );
  });

  it('should insert sibling bundles before body element if no HEAD', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-css-head/index.html'),
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
        type: 'css',
        assets: ['index.css'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(
      /<html>\s*<link rel="stylesheet" href="[/\\]{1}index\.[a-f0-9]+\.css">\s*<body>/.test(
        html,
      ),
    );
  });

  it('should insert sibling bundles after doctype if no html', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-css-doctype/index.html'),
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
        type: 'css',
        assets: ['index.css'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(
      /^\s*<!DOCTYPE html>\s*<link .*>\s*<script .*>\s*<\/script>\s*$/.test(
        html,
      ),
    );
  });

  it.skip('should insert sibling JS bundles for CSS files in the HEAD', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-css-js/index.html'),
      {
        hmr: true,
      },
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.css'],
      },
      {
        type: 'js',
        assets: ['index.css', 'css-loader.js', 'hmr-runtime.js'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(/<script src="[/\\]{1}index\.[a-f0-9]+\.js">/.test(html));
  });

  it('should insert sibling bundles at correct location in tree when optional elements are absent', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/html-css-optional-elements/index.html',
      ),
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
        type: 'css',
        assets: ['index.css'],
      },
      {
        type: 'js',
        assets: ['other.js'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    assert(
      /^<link rel="stylesheet" href="[/\\]index\.[a-f0-9]+\.css">\s*<script type="module" src="[/\\]index\.[a-f0-9]+\.js"><\/script>\s*<h1>Hello/m.test(
        html,
      ),
    );
  });

  it('should combine sibling CSS from multiple script tags into one bundle', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-css-multi/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['a.js'],
      },
      {
        type: 'js',
        assets: ['b.js'],
      },
      {
        type: 'css',
        assets: ['a.css', 'b.css'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    assert.equal(
      html.match(
        /<link rel="stylesheet" href="[/\\]{1}index\.[a-f0-9]+?\.css">/g,
      ).length,
      1,
    );

    assert.equal(
      html.match(/<script type="module" src="[/\\]{1}index\.[a-f0-9]+?\.js">/g)
        .length,
      2,
    );
  });

  it('should deduplicate shared code between script tags', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js-dedup/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['component-1.js', 'obj.js', 'esmodule-helpers.js'],
      },
      {
        type: 'js',
        assets: ['component-2.js'],
      },
    ]);

    let o = [];
    await run(b, {
      output: v => o.push(v),
    });

    assert.deepEqual(o, ['component-1', 'component-2']);
  });

  it('should minify HTML in production mode', async function () {
    let inputFile = path.join(__dirname, '/integration/htmlnano/index.html');
    await bundle(inputFile, {
      defaultTargetOptions: {
        shouldOptimize: true,
      },
    });

    let inputSize = (await inputFS.stat(inputFile)).size;

    let outputFile = path.join(distDir, 'index.html');
    let outputSize = (await outputFS.stat(outputFile)).size;

    assert(inputSize > outputSize);

    let html = await outputFS.readFile(outputFile, 'utf8');
    assert(html.includes('Other page'));
  });

  it('should work with an empty html file', async function () {
    let inputFile = path.join(__dirname, '/integration/html-empty/index.html');
    await bundle(inputFile, {
      defaultTargetOptions: {
        shouldOptimize: false,
      },
    });

    let outputFile = path.join(distDir, 'index.html');
    let html = await outputFS.readFile(outputFile, 'utf8');
    assert.equal(html.length, 0);
  });

  it('should work with an invalid html file', async function () {
    let inputFile = path.join(
      __dirname,
      '/integration/html-invalid/index.html',
    );
    await bundle(inputFile, {
      defaultTargetOptions: {
        shouldOptimize: false,
      },
    });

    let outputFile = path.join(distDir, 'index.html');
    let html = await outputFS.readFile(outputFile, 'utf8');
    assert(html.includes('This is a paragraph'));
  });

  it("should work with html that doesn't include optional closing tags", async function () {
    let inputFile = path.join(
      __dirname,
      '/integration/html-optional-closing-tags/index.html',
    );
    await bundle(inputFile, {
      defaultTargetOptions: {
        shouldOptimize: false,
      },
    });

    let outputFile = path.join(distDir, 'index.html');
    let html = await outputFS.readFile(outputFile, 'utf8');
    assert(html.includes('Paragraph 1'));
  });

  it('should read .htmlnanorc.json and minify HTML in production mode', async function () {
    await bundle(
      path.join(__dirname, '/integration/htmlnano-config/index.html'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    // minifyJson
    assert(
      html.includes('<script type=application/json>{"user":"me"}</script>'),
    );

    // mergeStyles
    assert(html.includes('<style>h1{color:red}div{font-size:20px}</style>'));

    assert(!html.includes('sourceMappingURL'));

    // minifySvg is false
    assert(
      html.includes(
        '<svg version=1.1 baseprofile=full width=300 height=200 xmlns=http://www.w3.org/2000/svg><rect width=100% height=100% fill=red></rect><circle cx=150 cy=100 r=80 fill=green></circle><text x=150 y=125 font-size=60 text-anchor=middle fill=white>SVG</text></svg>',
      ),
    );
  });

  it('should detect the version of SVGO to use', async function () {
    // Test is outside parcel so that svgo is not already installed.
    await fsFixture(overlayFS, '/')`
      htmlnano-svgo-version
        index.html:
          <!DOCTYPE html>
          <html>
            <body>
              <svg><rect id="test" /></svg>
            </body>
          </html>

        .htmlnanorc:
          {
            "minifySvg": {
              "full": true
            }
          }

        yarn.lock:
    `;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });

    try {
      await bundle(path.join('/htmlnano-svgo-version/index.html'), {
        inputFS: overlayFS,
        defaultTargetOptions: {
          shouldOptimize: true,
        },
        shouldAutoinstall: false,
      });
    } catch (err) {
      // autoinstall is disabled
      assert.equal(
        err.diagnostics[0].message,
        md`Could not resolve module "svgo" from "${path.resolve(
          overlayFS.cwd(),
          '/htmlnano-svgo-version/index',
        )}"`,
      );
    }

    loggerDisposable.dispose();
    assert(
      messages[0].diagnostics[0].message.startsWith(
        'Detected deprecated SVGO v2 options in',
      ),
    );
    assert.deepEqual(messages[0].diagnostics[0].codeFrames, [
      {
        filePath: path.resolve(
          overlayFS.cwd(),
          '/htmlnano-svgo-version/.htmlnanorc',
        ),
        codeHighlights: [
          {
            message: undefined,
            start: {
              line: 3,
              column: 5,
            },
            end: {
              line: 3,
              column: 16,
            },
          },
        ],
      },
    ]);
  });

  it('should not minify default values inside HTML in production mode', async function () {
    let inputFile = path.join(
      __dirname,
      '/integration/htmlnano-defaults-form/index.html',
    );
    await bundle(inputFile, {
      defaultTargetOptions: {
        shouldOptimize: true,
      },
    });

    let inputSize = (await inputFS.stat(inputFile)).size;

    let outputFile = path.join(distDir, '/index.html');
    let outputSize = (await outputFS.stat(outputFile)).size;

    assert(inputSize > outputSize);

    let html = await outputFS.readFile(outputFile, 'utf8');
    assert(html.includes('<input type="text">'));
  });

  it('should not prepend the public path to assets with remote URLs', async function () {
    await bundle(path.join(__dirname, '/integration/html/index.html'));

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(
      html.includes('<script src="https://unpkg.com/parcel-bundler"></script>'),
    );
  });

  it('should not prepend the public path to hash links', async function () {
    await bundle(path.join(__dirname, '/integration/html/index.html'));

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('<a href="#hash_link">'));
  });

  it('should detect virtual paths', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-virtualpath/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'html',
        assets: ['other.html'],
      },
    ]);
  });

  it('should not update root/main file in the bundles', async function () {
    await bundle(path.join(__dirname, '/integration/html-root/index.html'));

    let files = await outputFS.readdir(distDir);

    for (let file of files) {
      if (file !== 'index.html' && file.endsWith('.html')) {
        let html = await outputFS.readFile(path.join(distDir, file), 'utf8');
        assert(html.includes('index.html'));
      }
    }
  });

  it('should preserve the spacing in the HTML tags', async function () {
    await bundle(path.join(__dirname, '/integration/html/index.html'));

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(/<i>hello<\/i> <i>world<\/i>/.test(html));
  });

  it('should support child bundles of different types', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/child-bundle-different-types/index.html',
      ),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['main.js', 'util.js', 'other.js'],
      },
      {
        type: 'html',
        assets: ['other.html'],
      },
      {
        type: 'js',
        assets: ['index.js', 'util.js', 'other.js'],
      },
    ]);
  });

  it.skip('should support circular dependencies', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/circular/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'html',
        assets: ['about.html'],
      },
      {
        type: 'js',
        assets: ['about.js', 'index.js'],
      },
      {
        type: 'html',
        assets: ['test.html'],
      },
      {
        type: 'js',
        assets: ['about.js', 'index.js'],
      },
    ]);
  });

  it('should support bundling HTM', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/htm-extension/index.htm'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.htm'],
        type: 'html',
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);
  });

  it('should detect srcset attribute', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-srcset/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'png',
        assets: ['200x200.png'],
      },
      {
        type: 'png',
        assets: ['300x300.png'],
      },
    ]);
  });

  it('should detect srcset attribute of source element', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-source-srcset/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'png',
        assets: ['200x200.png'],
      },
      {
        type: 'png',
        assets: ['300x300.png'],
      },
    ]);

    const html = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');

    const source = html.match(/<source srcset=".*>/)[0];

    assert(source.split(', ').length === 3);
  });

  it('should detect imagesrcset attribute', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-imagesrcset/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'png',
        assets: ['200x200.png'],
      },
      {
        type: 'png',
        assets: ['300x300.png'],
      },
    ]);
  });

  it.skip('should support webmanifest', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/webmanifest/index.html'),
    );

    assertBundles(b, {
      name: 'index.html',
      assets: ['index.html'],
      childBundles: [
        {
          type: 'webmanifest',
          assets: ['manifest.webmanifest'],
          childBundles: [
            {
              type: 'txt',
              assets: ['some.txt'],
              childBundles: [],
            },
          ],
        },
      ],
    });
  });

  it.skip("should treat webmanifest as an entry module so it doesn't get content hashed", async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/html-manifest/index.html'),
    );

    assertBundles(b, {
      name: 'index.html',
      assets: ['index.html'],
      childBundles: [
        {
          type: 'webmanifest',
          assets: ['manifest.webmanifest'],
        },
      ],
    });

    const html = await outputFS.readFile(
      path.join(__dirname, '/dist/index.html'),
      'utf8',
    );
    assert(html.includes('<link rel="manifest" href="/manifest.webmanifest">'));
  });

  it('should bundle svg files correctly', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-svg/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'svg',
        assets: ['file.svg'],
      },
    ]);
  });

  it('should ignore svgs referencing local symbols via <use xlink:href="#">', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-svg-local-symbol/index.html'),
      {
        mode: 'production',
      },
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let contents = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      contents.includes(
        '<svg><symbol id="all"><rect width="100" height="100"/></symbol></svg><svg><use href="#all"/></svg>',
      ),
    );
  });

  it('should bundle svg files using <image xlink:href=""> correctly', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-svg-image/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'svg',
        assets: ['file.svg'],
      },
    ]);
  });

  it("should support href attribute in <image /> in HTMLTransformer's collectDependencies", async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-image-href-attr/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
    ]);
  });

  // Based on https://developer.mozilla.org/en-US/docs/Web/SVG/Element/script
  it('should bundle scripts inside svg', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-svg-script/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['script-a.js'],
      },
      {
        type: 'js',
        assets: ['script-b.js'],
      },
    ]);
  });

  it('should support data attribute of object element', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-object/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'svg',
        assets: ['file.svg'],
      },
    ]);
  });

  it('should resolve assets containing spaces', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/resolve-spaces/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'html',
        assets: ['other page.html'],
      },
    ]);
  });

  it('should process inline JS', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-js/index.html'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    // inline bundles are not output, but are apart of the bundleGraph
    assertBundles(b, [
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {type: 'js', assets: ['index.html']},
      {name: 'index.html', assets: ['index.html']},
    ]);

    let files = await outputFS.readdir(distDir);
    // assert that the inline js files are not output
    assert(!files.some(filename => filename.includes('js')));

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf-8',
    );

    assert(!html.includes('someArgument'));
  });

  it('should process inline styles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-styles/index.html'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        type: 'jpg',
        assets: ['bg.jpg'],
      },
      {
        type: 'jpg',
        assets: ['img.jpg'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let bundles = b.getBundles();

    let html = await outputFS.readFile(
      bundles.find(bundle => bundle.type === 'html').filePath,
      'utf8',
    );

    let urls = [...html.matchAll(/url\(([^)]*)\)/g)].map(m => m[1]);
    assert.strictEqual(urls.length, 2);
    for (let url of urls) {
      assert(
        bundles.find(
          bundle =>
            bundle.bundleBehavior !== 'inline' &&
            path.basename(bundle.filePath) === url,
        ),
      );
    }
  });

  it('should process inline element styles', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/html-inline-styles-element/index.html',
      ),
      {shouldDisableCache: false},
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);
  });

  it('should process inline styles using lang', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-sass/index.html'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('<style>.index{color:#00f}</style>'));
    assert(!html.includes('sourceMappingURL'));
  });

  it('should process inline non-js scripts', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-coffeescript/index.html'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('alert("Hello, World!")'));
  });

  it('should handle inline css with @imports', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-css-import/index.html'),
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['index.html', 'test.css'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(!html.includes('@import'));
  });

  it('should not modify inline importmaps', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-importmap/index.html'),
      {},
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(html.includes('/node_modules/lit1.3.0/'));
  });

  it('should expose top level declarations globally in inline <script> tags', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-js-script/globals.html'),
    );

    let logs = [];
    let ctx = await run(
      b,
      {
        log(bar, baz) {
          logs.push([bar, baz]);
        },
      },
      {require: false},
    );
    let output = ctx.output;
    assert.equal(output.x, 2);
    assert.equal(output.y, 'undefined');
    assert.equal(output.z, 4);
    assert.equal(typeof output.bar, 'function');
    assert.equal(output.Test, 'undefined');
    assert.equal(typeof output.Foo, 'function');
    assert.equal(typeof output.baz, 'function');

    // x is a let, so is "global" but not part of the global object
    assert(!('x' in ctx));
    assert(!('y' in ctx));
    assert.equal(ctx.z, 4);
    assert.equal(typeof ctx.bar, 'function');
    assert(!('Test' in ctx));
    assert(!('Foo' in ctx));
    assert.equal(typeof ctx.baz, 'function');

    assert.deepEqual(logs, [
      ['undefined', 'function'],
      ['function', 'function'],
      ['function', 'function'],
    ]);
  });

  for (let scopeHoist of [false, true]) {
    it(
      'should expose top level declarations globally in inline <script> tags with dependencies with scopeHoist = ' +
        scopeHoist,
      async function () {
        let b = await bundle(
          path.join(
            __dirname,
            '/integration/html-inline-js-script/globals-dependencies.html',
          ),
          {
            defaultTargetOptions: {
              shouldScopeHoist: scopeHoist,
            },
          },
        );

        let logs = [];
        let ctx = await run(
          b,
          {
            log(bar, baz) {
              logs.push([bar, baz]);
            },
          },
          {require: false},
        );
        let output = ctx.output;
        assert.equal(output.x, 2);
        assert.equal(output.y, 'undefined');
        assert.equal(output.z, 4);
        assert.equal(typeof output.bar, 'function');
        assert.equal(output.Test, 'undefined');
        assert.equal(typeof output.Foo, 'function');
        assert.equal(typeof output.baz, 'function');

        // x is a let, so is "global" but not part of the global object
        assert(!('x' in ctx));
        assert(!('y' in ctx));
        assert.equal(ctx.z, 4);
        assert.equal(typeof ctx.bar, 'function');
        assert(!('Test' in ctx));
        assert(!('Foo' in ctx));
        assert.equal(typeof ctx.baz, 'function');

        assert.deepEqual(logs, [
          ['undefined', 'function'],
          ['function', 'function'],
          ['function', 'function'],
        ]);

        let contents = await outputFS.readFile(
          b.getBundles()[0].filePath,
          'utf8',
        );
        if (scopeHoist) {
          assert(contents.includes('import('));
        } else {
          assert(!contents.includes('import('));
        }
      },
    );
  }

  it('should error on imports in inline scripts without type="module"', async function () {
    let errored = false;
    try {
      await bundle(
        path.join(__dirname, '/integration/html-inline-js-script/error.html'),
      );
    } catch (err) {
      assert.equal(
        err.message,
        'Browser scripts cannot have imports or exports.',
      );
      assert.deepEqual(err.diagnostics, [
        {
          message: 'Browser scripts cannot have imports or exports.',
          origin: '@parcel/transformer-js',
          codeFrames: [
            {
              filePath: path.join(
                __dirname,
                '/integration/html-inline-js-script/error.html',
              ),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 5,
                    column: 7,
                  },
                  end: {
                    line: 5,
                    column: 24,
                  },
                },
              ],
            },
          ],
          hints: ['Add the type="module" attribute to the <script> tag.'],
          documentationURL:
            'https://parceljs.org/languages/javascript/#classic-scripts',
        },
      ]);

      errored = true;
    }

    assert(errored);
  });

  it('should not import swc/helpers without type="module"', async function () {
    await bundle(
      path.join(
        __dirname,
        '/integration/html-js-not-import-swc-helpers-without-module/index.html',
      ),
      {
        defaultTargetOptions: {
          engines: {
            // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Destructuring_assignment#browser_compatibility
            browsers: ['Chrome 48'],
          },
        },
      },
    );

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(!html.includes('swc/helpers'));
    assert(html.includes('sliced_to_array'));
  });

  it('should allow imports and requires in inline <script> tags', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-js-require/index.html'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.html', 'test.js'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('console.log("test")'));
  });

  it('should support protocol-relative urls', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-protocol-relative/index.html'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'css',
        assets: ['index.css'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let contents = await outputFS.readFile(bundle.filePath, 'utf8');
      assert(contents.includes('//unpkg.com/xyz'));
    }
  });

  it('should support inline <script type="module">', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-js-module/index.html'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('<script type="module">'));
    assert(html.includes('document.write("Hello world")'));
  });

  it('should compile inline <script type="module"> to non-module if not all engines support esmodules', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-js-module/index.html'),
      {
        defaultTargetOptions: {
          mode: 'production',
          shouldScopeHoist: true,
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    await assertBundles(b, [
      {
        type: 'js',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(!html.includes('<script type="module">'));
    assert(html.includes('<script>'));
    assert(html.includes('document.write("Hello world")'));
  });

  it('should compile a module and nomodule script when not all engines support esmodules natively', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js/index.html'),
      {
        defaultTargetOptions: {
          mode: 'production',
          shouldScopeHoist: true,
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    await assertBundles(b, [
      {
        type: 'js',
        assets: ['index.js', 'other.js'],
      },
      {
        type: 'js',
        assets: ['index.js', 'other.js'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let bundles = b.getBundles();
    let html = await outputFS.readFile(
      bundles.find(b => b.type === 'html').filePath,
      'utf8',
    );
    assert(html.includes('<script type="module" src='));
    assert(/<script src=".*?" nomodule/.test(html));

    let js = await outputFS.readFile(
      bundles.find(b => b.type === 'js' && b.env.outputFormat === 'esmodule')
        .filePath,
      'utf8',
    );
    assert(/class \$[a-f0-9]+\$var\$Useless \{/.test(js));

    js = await outputFS.readFile(
      bundles.find(b => b.type === 'js' && b.env.outputFormat === 'global')
        .filePath,
      'utf8',
    );
    assert(!/class \$[a-f0-9]+\$var\$Useless \{/.test(js));
  });

  it('should not add a nomodule version when all browsers support esmodules', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js/index.html'),
      {
        defaultTargetOptions: {
          mode: 'production',
          shouldScopeHoist: true,
          engines: {
            browsers: 'last 1 Chrome version',
          },
        },
      },
    );

    await assertBundles(b, [
      {
        type: 'js',
        assets: ['index.js', 'other.js'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('<script type="module" src='));
    assert(!/<script src=".*?" nomodule/.test(html));
  });

  it('should error on imports in scripts without type="module"', async function () {
    let errored = false;
    try {
      await bundle(path.join(__dirname, '/integration/html-js/error.html'));
    } catch (err) {
      assert.equal(
        err.message,
        'Browser scripts cannot have imports or exports.',
      );
      assert.deepEqual(err.diagnostics, [
        {
          message: 'Browser scripts cannot have imports or exports.',
          origin: '@parcel/transformer-js',
          codeFrames: [
            {
              filePath: path.join(__dirname, '/integration/html-js/index.js'),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 1,
                    column: 1,
                  },
                  end: {
                    line: 1,
                    column: 29,
                  },
                },
              ],
            },
            {
              filePath: path.join(__dirname, '/integration/html-js/error.html'),
              codeHighlights: [
                {
                  message: 'The environment was originally created here',
                  start: {
                    line: 1,
                    column: 1,
                  },
                  end: {
                    line: 1,
                    column: 32,
                  },
                },
              ],
            },
          ],
          hints: ['Add the type="module" attribute to the <script> tag.'],
          documentationURL:
            'https://parceljs.org/languages/javascript/#classic-scripts',
        },
      ]);

      errored = true;
    }

    assert(errored);
  });

  it('should correctly bundle loaders for nested dynamic imports', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/html-js-shared-dynamic-nested/index.html',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          engines: {
            browsers: '>= 0.25%',
          },
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: [
          'cacheLoader.js',
          'index.js',
          'index.js',
          'index.js',
          'js-loader.js',
        ],
      },
      {
        type: 'js',
        assets: ['index.js', 'index.js', 'index.js'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['simpleHasher.js'],
      },
      {
        type: 'js',
        assets: ['simpleHasher.js'],
      },
    ]);

    let res = await run(b, {output: null}, {require: false});
    assert.deepEqual(await res.output, ['hasher', ['hasher', 'hasher']]);
  });

  it('should support shared bundles between multiple inline scripts', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-inline-js-shared/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['lodash.js'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    assert(html.includes('<script type="module" src="'));
    assert(html.includes('<script type="module">'));
    assert(html.includes('.add(1, 2)'));
    assert(html.includes('.add(2, 3)'));
  });

  it('inserts sibling bundles into html in the correct order (no head)', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js-shared/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['async.js'],
      },
      {
        type: 'js',
        assets: ['get-worker-url.js', 'index.js', 'lodash.js'],
      },
      {
        name: 'index.html',
        type: 'html',
        assets: ['index.html'],
      },
      // {
      //   type: 'js',
      //   assets: ['lodash.js'],
      // },
      {
        type: 'js',
        assets: ['worker.js', 'lodash.js'],
      },
    ]);

    // let lodashSibling = path.basename(
    //   b.getBundles().find(v => v.getEntryAssets().length === 0).filePath,
    // );

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    let insertedBundles = [];
    let regex = /<script (?:type="[^"]+" )?src="([^"]*)"><\/script>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      insertedBundles.push(path.basename(match[1]));
    }

    assert.equal(insertedBundles.length, 1);
    // assert.equal(insertedBundles.length, 2);
    // assert.equal(insertedBundles[0], lodashSibling);
  });

  it('inserts sibling bundles into html in the correct order (head)', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js-shared-head/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['async.js'],
      },
      {
        type: 'js',
        assets: ['get-worker-url.js', 'index.js', 'lodash.js'],
      },
      {
        name: 'index.html',
        type: 'html',
        assets: ['index.html'],
      },
      // {
      //   type: 'js',
      //   assets: ['lodash.js'],
      // },
      {
        type: 'js',
        assets: ['worker.js', 'lodash.js'],
      },
    ]);

    // let lodashSibling = path.basename(
    //   b.getBundles().find(v => v.getEntryAssets().length === 0).filePath,
    // );

    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    let insertedBundles = [];
    let regex = /<script (?:type="[^"]+" )?src="([^"]*)"><\/script>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      insertedBundles.push(path.basename(match[1]));
    }

    assert.equal(insertedBundles.length, 1);
    // assert.equal(insertedBundles.length, 2);
    // assert.equal(insertedBundles[0], lodashSibling);
  });

  it('inserts sibling bundles into html with nomodule or type=module', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-js-shared-nomodule/*.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'a.html',
        assets: ['a.html'],
      },
      {
        type: 'js',
        assets: ['a.js'],
      },
      {
        type: 'js',
        assets: ['a.js'],
      },
      {
        name: 'b.html',
        assets: ['b.html'],
      },
      {
        type: 'js',
        assets: ['b.js'],
      },
      {
        type: 'js',
        assets: ['b.js'],
      },
      {
        type: 'js',
        assets: ['lib.js'],
      },
      {
        type: 'js',
        assets: ['lib.js'],
      },
    ]);

    for (let file of b
      .getBundles()
      .filter(b => b.type === 'html')
      .map(b => b.filePath)) {
      let html = await outputFS.readFile(file, 'utf8');

      let noModuleScripts = [];
      let moduleScripts = [];

      let regex = /<script ([^>]*)><\/script>/g;
      let match;
      while ((match = regex.exec(html)) !== null) {
        let attributes = new Map(match[1].split(' ').map(a => a.split('=')));
        let url = attributes.get('src').replace(/"/g, '');
        assert(url);
        if (attributes.get('type') === '"module"') {
          assert.strictEqual(attributes.size, 2);
          moduleScripts.push(path.basename(url));
        } else {
          assert.strictEqual(attributes.size, 3);
          assert(attributes.get('nomodule'));
          assert(attributes.get('defer'));
          noModuleScripts.push(path.basename(url));
        }
      }

      for (let scripts of [moduleScripts, noModuleScripts]) {
        assert.strictEqual(scripts.length, 2);
        assert(
          b
            .getBundles()
            .find(b => b.filePath.endsWith(scripts[0]))
            .getMainEntry() == null,
        );
        assert(
          b
            .getBundles()
            .find(b => b.filePath.endsWith(scripts[1]))
            .getMainEntry(),
        );
      }
    }
  });

  it('supports multiple dist targets', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-multi-targets/'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: false,
          shouldOptimize: false,
          sourceMaps: false,
        },
      },
    );
    assertBundles(b, [
      {
        name: 'index.html',
        type: 'html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
      {
        type: 'js',
        assets: ['esmodule-helpers.js', 'shared.js'],
      },
      {
        type: 'js',
        assets: ['esmodule-helpers.js', 'shared.js'],
      },
      {
        name: 'index.html',
        type: 'html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);
  });
  it('should isolate async scripts', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-async-script/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
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
        assets: ['a.js', 'c.js'],
      },
      {
        assets: ['b.js', 'c.js'],
      },
    ]);

    let output = [];
    await run(b, {
      output(o) {
        output.push(o);
      },
    });

    // could run in either order.
    assert(output.sort(), ['a', 'b', 'c']);
  });

  it('should isolate classic scripts from nomodule scripts', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-isolate-script/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
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
        assets: ['a.js'],
      },
      {
        assets: ['a.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        assets: ['b.js', 'cacheLoader.js', 'js-loader.js'],
      },
      {
        assets: ['c.js'],
      },
      {
        assets: ['c.js'],
      },
    ]);

    let output = [];
    await run(b, {
      output(o) {
        output.push(o);
      },
    });

    // could run in either order.
    assert(output.sort(), ['a', 'b', 'c']);
  });

  it('should support multiple entries with shared sibling bundles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/shared-sibling-entries/*.html'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['a.html'],
      },
      {
        type: 'js',
        assets: ['b.html'],
      },
      {
        type: 'js',
        assets: ['c.html'],
      },
      {
        name: 'a.html',
        type: 'html',
        assets: ['a.html'],
      },
      {
        name: 'b.html',
        type: 'html',
        assets: ['b.html'],
      },
      {
        name: 'c.html',
        type: 'html',
        assets: ['c.html'],
      },
      {
        type: 'css',
        assets: ['other.css', 'shared.css'],
      },
      {
        type: 'js',
        assets: ['shared.js'],
      },
    ]);

    // Both HTML files should point to the sibling CSS file
    let html = await outputFS.readFile(path.join(distDir, 'a.html'), 'utf8');
    assert(/<link rel="stylesheet" href="\/a\.[a-z0-9]+\.css">/.test(html));

    html = await outputFS.readFile(path.join(distDir, 'b.html'), 'utf8');
    assert(/<link rel="stylesheet" href="\/a\.[a-z0-9]+\.css">/.test(html));

    html = await outputFS.readFile(path.join(distDir, 'c.html'), 'utf8');
    assert(/<link rel="stylesheet" href="\/a\.[a-z0-9]+\.css">/.test(html));
  });

  it('should insert JS sibling bundle script tags in the correct order', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        'integration/scope-hoisting/es6/interop-async/index.html',
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldScopeHoist: true,
          shouldOptimize: false,
        },
      },
    );
    let bundles = b.getBundles();
    assertBundles(b, [
      {
        name: 'index.html',
        type: 'html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['index.js', 'index.js', 'index.js', 'index.js', 'client.js'],
      },
      {
        type: 'js',
        assets: ['viewer.js'],
      },
    ]);
    let html = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );

    let insertedBundles = [];
    let regex = /<script (?:type="[^"]+" )?src="([^"]*)"><\/script>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      let bundle = bundles.find(
        b => path.basename(b.filePath) === path.basename(match[1]),
      );

      insertedBundles.push(bundle);
    }

    assert.equal(insertedBundles.length, 1);

    let res = await run(b, {output: null}, {require: false});
    assert.deepEqual(await res.output, ['client', 'client', 'viewer']);
  });

  it('should not point to unrelated sibling bundles', async function () {
    await bundle(
      path.join(
        __dirname,
        '/integration/shared-sibling-entries-multiple/*.html',
      ),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    // a.html should point to a CSS bundle containing a.css as well as
    // reuse the b.css bundle from b.html.
    let html = await outputFS.readFile(path.join(distDir, 'a.html'), 'utf8');
    assert.equal(
      html.match(/<link rel="stylesheet" href="\/\w+\.[a-z0-9]+\.css">/g)
        .length,
      2,
    );

    // a.html should reference a.js only
    assert.equal(html.match(/a\.[a-z0-9]+\.js/g).length, 1);

    assert.equal(html.match(/b\.[a-z0-9]+\.js/g), null);

    let css = await outputFS.readFile(
      path.join(distDir, html.match(/\/\w+\.[a-z0-9]+\.css/g)[0]),
      'utf8',
    );
    assert(css.includes('.a {'));
    assert(!css.includes('.b {'));

    // b.html should point to a CSS bundle containing only b.css
    // It should not point to the bundle containing a.css from a.html
    html = await outputFS.readFile(path.join(distDir, 'b.html'), 'utf8');
    assert.equal(
      html.match(/<link rel="stylesheet" href="\/\w+\.[a-z0-9]+\.css">/g)
        .length,
      1,
    );

    // b.html should reference b.js only
    assert.equal(html.match(/a\.[a-z0-9]+\.js/g), null);

    assert.equal(html.match(/b\.[a-z0-9]+\.js/g).length, 1);

    css = await outputFS.readFile(
      path.join(distDir, html.match(/\/\w+\.[a-z0-9]+\.css/)[0]),
      'utf8',
    );
    assert(!css.includes('.a {'));
    assert(css.includes('.b {'));
  });

  it('should support split bundles with many pages', async function () {
    await bundle(path.join(__dirname, '/integration/shared-many/*.html'), {
      mode: 'production',
    });

    let html = await outputFS.readFile(path.join(distDir, 'a.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 2);

    html = await outputFS.readFile(path.join(distDir, 'b.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 2);

    html = await outputFS.readFile(path.join(distDir, 'c.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 2);

    html = await outputFS.readFile(path.join(distDir, 'd.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 2);

    html = await outputFS.readFile(path.join(distDir, 'e.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 1);

    html = await outputFS.readFile(path.join(distDir, 'f.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 1);

    // b.html hitting the parallel request limit should not prevent g.html from being optimized
    html = await outputFS.readFile(path.join(distDir, 'g.html'), 'utf8');
    assert.equal(html.match(/<script/g).length, 1);
  });

  it('should not add CSS to a worker bundle group', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/shared-sibling-worker-css/index.html'),
    );

    assertBundles(b, [
      {
        type: 'css',
        assets: ['style.css'],
      },
      {
        type: 'html',
        assets: ['index.html'],
      },
      {
        type: 'js',
        assets: ['a.js', 'worker.js', 'esmodule-helpers.js'],
      },
      {
        type: 'js',
        assets: [
          'a.js',
          'esmodule-helpers.js',
          'get-worker-url.js',
          'index.js',
        ],
      },
    ]);

    let htmlBundle = b.getBundles().find(b => b.type === 'html');
    let htmlSiblings = b.getReferencedBundles(htmlBundle);
    assert.equal(htmlSiblings.length, 2);
    assert(htmlSiblings.some(b => b.type === 'js'));
    assert(htmlSiblings.some(b => b.type === 'css'));

    let worker = b.getChildBundles(htmlSiblings.find(b => b.type === 'js'));
    assert.equal(worker.length, 1);
    let workerSiblings = b.getReferencedBundles(worker[0]);
    assert.equal(workerSiblings.length, 0);
  });

  it('should correctly add sibling bundles to all using bundles', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/shared-sibling/*.html'),
    );

    assertBundles(b, [
      {
        type: 'html',
        assets: ['form.html'],
      },
      {
        type: 'js',
        assets: ['form.js', 'a.js', 'a.module.css', 'esmodule-helpers.js'],
      },
      {
        type: 'css',
        assets: ['a.module.css'],
      },
      {
        type: 'css',
        assets: ['a.module.css'],
      },
      {
        type: 'css',
        assets: ['a.module.css'],
      },
      {
        type: 'html',
        assets: ['searchfield.html'],
      },
      {
        type: 'js',
        assets: [
          'searchfield.js',
          'a.js',
          'a.module.css',
          'b.js',
          'esmodule-helpers.js',
        ],
      },
      {
        type: 'html',
        assets: ['searchfield2.html'],
      },
      {
        type: 'js',
        assets: [
          'searchfield2.js',
          'a.js',
          'a.module.css',
          'b.js',
          'esmodule-helpers.js',
        ],
      },
    ]);

    for (let htmlBundle of b.getBundles().filter(b => b.type === 'html')) {
      let htmlSiblings = b
        .getReferencedBundles(htmlBundle, true)
        .map(b => b.type)
        .sort();
      assert.deepEqual(htmlSiblings, ['css', 'js']);
    }
  });

  it('should remove duplicate assets from sibling bundles', async function () {
    let bundleGraph = await bundle(
      path.join(__dirname, '/integration/shared-sibling-duplicate/*.html'),
      {mode: 'production'},
    );

    bundleGraph.traverseBundles(bundle => {
      bundle.traverseAssets(asset => {
        let bundles = bundleGraph.getBundlesWithAsset(asset);
        assert.equal(
          bundles.length,
          1,
          `asset ${asset.filePath} is duplicated`,
        );
      });
    });
  });

  it('should support split bundles with many pages with esmodule output', async function () {
    await bundle(path.join(__dirname, '/integration/shared-many-esm/*.html'), {
      defaultTargetOptions: {
        shouldScopeHoist: true,
      },
    });

    let checkHtml = async filename => {
      // Find all scripts referenced in the HTML file
      let html = await outputFS.readFile(path.join(distDir, filename), 'utf8');
      let re = /<script.*?src="(.*?)"/g;
      let match;
      let scripts = new Set();
      while ((match = re.exec(html))) {
        scripts.add(path.join(distDir, match[1]));
      }

      assert(scripts.size > 0, 'no scripts found');

      // Ensure that those scripts don't import anything other than what's in the HTML.
      for (let script of scripts) {
        let js = await outputFS.readFile(script, 'utf8');
        let re = /import .*? from "(.*?)"/g;
        let match;
        while ((match = re.exec(js))) {
          let imported = path.join(distDir, match[1]);
          assert(
            scripts.has(imported),
            `unknown script ${match[1]} imported in ${path.basename(script)}`,
          );
        }
      }
    };

    for (let letter of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
      await checkHtml(letter + '.html');
    }
  });

  it('should include the correct paths when using multiple entries and referencing style from html and js', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/html-multi-entry/*.html'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'a.html',
        type: 'html',
        assets: ['a.html'],
      },
      {
        name: 'b.html',
        type: 'html',
        assets: ['b.html'],
      },
      {
        type: 'css',
        assets: ['style.css'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);

    let firstHtmlFile = await outputFS.readFile(
      path.join(distDir, 'a.html'),
      'utf8',
    );

    let secondHtmlFile = await outputFS.readFile(
      path.join(distDir, 'b.html'),
      'utf8',
    );

    let bundles = b.getBundles();
    let cssBundle = path.basename(
      bundles.find(bundle => bundle.filePath.endsWith('.css')).filePath,
    );
    let jsBundle = path.basename(
      bundles.find(bundle => bundle.filePath.endsWith('.js')).filePath,
    );

    assert(
      firstHtmlFile.includes(cssBundle),
      `a.html should include a reference to ${cssBundle}`,
    );
    assert(
      secondHtmlFile.includes(cssBundle),
      `b.html should include a reference to ${cssBundle}`,
    );

    assert(
      firstHtmlFile.includes(jsBundle),
      `a.html should include a reference to ${jsBundle}`,
    );
    assert(
      secondHtmlFile.includes(jsBundle),
      `b.html should include a reference to ${jsBundle}`,
    );
  });

  it('should invalidate parent bundle when inline bundles change', async function () {
    // copy into memory fs
    await ncp(
      path.join(__dirname, '/integration/html-inline-js-require'),
      path.join(__dirname, '/html-inline-js-require'),
    );

    let distDir = path.join(outputFS.cwd(), 'dist');

    let b = await bundler(
      path.join(__dirname, '/html-inline-js-require/index.html'),
      {
        inputFS: overlayFS,
        shouldDisableCache: false,
        defaultTargetOptions: {
          distDir,
        },
      },
    );

    subscription = await b.watch();
    await getNextBuild(b);

    let html = await outputFS.readFile('/dist/index.html', 'utf8');
    assert(html.includes(`console.log('test')`));

    await overlayFS.writeFile(
      path.join(__dirname, '/html-inline-js-require/test.js'),
      "console.log('foo')",
    );
    await getNextBuild(b);

    html = await outputFS.readFile(path.join(distDir, '/index.html'), 'utf8');
    assert(html.includes(`console.log('foo')`));
  });

  it('should invalidate parent bundle when nested inline bundles change', async function () {
    // copy into memory fs
    await ncp(
      path.join(__dirname, '/integration/html-inline-js-nested'),
      path.join(__dirname, '/html-inline-js-nested'),
    );

    let distDir = path.join(outputFS.cwd(), 'dist');

    let b = await bundler(
      path.join(__dirname, '/html-inline-js-nested/index.html'),
      {
        inputFS: overlayFS,
        shouldDisableCache: false,
        defaultTargetOptions: {
          distDir,
        },
      },
    );

    subscription = await b.watch();
    await getNextBuild(b);

    let html = await outputFS.readFile('/dist/index.html', 'utf8');
    assert(html.includes('module.exports = "hello world"'));
    assert(html.includes('console.log'));

    await overlayFS.writeFile(
      path.join(__dirname, '/html-inline-js-nested/test.txt'),
      'foo bar',
    );
    await getNextBuild(b);

    html = await outputFS.readFile(path.join(distDir, 'index.html'), 'utf8');
    assert(!html.includes('module.exports = "hello world"'));
    assert(html.includes('module.exports = "foo bar"'));
    assert(html.includes('console.log'));
  });

  it('should inline data-urls', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/data-url/index.html'),
      {
        defaultTargetOptions: {
          sourceMaps: false,
        },
      },
    );

    let contents = await outputFS.readFile(
      b.getBundles().find(b => b.type === 'html').filePath,
      'utf8',
    );
    assert.equal(
      contents.trim(),
      `<img src="data:image/svg+xml,%3Csvg%20width%3D%22120%22%20height%3D%22120%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%0A%20%20%3Cfilter%20id%3D%22blur-_.%21~%2a%22%3E%0A%20%20%20%20%3CfeGaussianBlur%20stdDeviation%3D%225%22%3E%3C%2FfeGaussianBlur%3E%0A%20%20%3C%2Ffilter%3E%0A%20%20%3Ccircle%20cx%3D%2260%22%20cy%3D%2260%22%20r%3D%2250%22%20fill%3D%22green%22%20filter%3D%22url%28%27%23blur-_.%21~%2a%27%29%22%3E%3C%2Fcircle%3E%0A%3C%2Fsvg%3E%0A">`,
    );
  });

  it('should print a diagnostic for invalid bundler options', async () => {
    let dir = path.join(__dirname, 'integration/invalid-bundler-config');
    let pkg = path.join(dir, 'package.json');
    let code = await inputFS.readFileSync(pkg, 'utf8');
    await assert.rejects(() => bundle(path.join(dir, 'index.html')), {
      name: 'BuildError',
      diagnostics: [
        {
          message: 'Invalid config for @parcel/bundler-default',
          origin: '@parcel/bundler-default',
          codeFrames: [
            {
              filePath: pkg,
              language: 'json',
              code,
              codeHighlights: [
                {
                  message: 'Did you mean "minBundleSize", "minBundles"?',
                  start: {
                    column: 30,
                    line: 3,
                  },
                  end: {
                    column: 45,
                    line: 3,
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('should escape inline script tags', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/html-inline-escape/script.html'),
    );
    let output;
    await run(b, {
      output(o) {
        output = o;
      },
    });

    assert.deepEqual(output, {
      a: '<script></script>',
      b: '<!-- test',
      c: '<SCRIPT></SCRIPT>',
    });
  });

  it('should share older JS sibling (script) assets to younger siblings', async function () {
    // JS script tags are siblings to a common parent, and are marked as such by parallel dependency priority
    // Becuase of load order any older sibling (and it's assets) are loaded before any subsequent sibling
    // Which means no younger sibling should have to reference sibling bundles for assets in them
    let b = await bundle(
      path.join(
        __dirname,
        'integration/scope-hoisting/es6/sibling-dependencies/index.html',
      ),
    );
    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        assets: ['a.js', 'esmodule-helpers.js'],
      },
      {
        assets: ['b.js'],
      },
    ]);

    let youngerSibling; // bundle containing younger sibling, b.js
    let olderSibling; // bundle containing old sibling, a.js
    b.traverseBundles(bundle => {
      bundle.traverseAssets(asset => {
        if (asset.filePath.includes('b.js')) {
          youngerSibling = bundle;
        } else if (asset.filePath.includes('a.js')) {
          olderSibling = bundle;
        }
      });
    });

    assert(
      b.getReferencedBundles(youngerSibling).filter(b => b == olderSibling)
        .length == 0,
    );

    let res = await run(b, {output: null}, {require: false});
    assert.equal(res.output, 'a');
  });

  it('should escape quotes in inline style attributes and style tags', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/html-inline-escape/style.html'),
    );
    let output = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes(`content: &quot;hi&quot;`));
    assert(output.includes('<\\/style>'));
  });

  it('should work with bundle names that have colons in them', async function () {
    if (process.platform === 'win32') {
      return;
    }

    // Windows paths cannot contain colons and will fail to git clone, so write the file here (in memory).
    await overlayFS.mkdirp(path.join(__dirname, 'integration/url-colon'));
    await overlayFS.writeFile(
      path.join(__dirname, 'integration/url-colon/a:b:c.html'),
      '<p>Test</p>',
    );

    let b = await bundle(
      path.join(__dirname, 'integration/url-colon/relative.html'),
      {inputFS: overlayFS},
    );

    assertBundles(b, [
      {
        name: 'relative.html',
        assets: ['relative.html'],
      },
      {
        name: 'a:b:c.html',
        assets: ['a:b:c.html'],
      },
    ]);

    let output = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('/a:b:c.html'));

    b = await bundle(
      path.join(__dirname, 'integration/url-colon/absolute.html'),
      {inputFS: overlayFS},
    );

    assertBundles(b, [
      {
        name: 'absolute.html',
        assets: ['absolute.html'],
      },
      {
        name: 'a:b:c.html',
        assets: ['a:b:c.html'],
      },
    ]);

    output = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('/a:b:c.html'));
  });

  it('should normalize case of SVG elements and attributes when minified', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/html-svg-case/index.html'),
      {
        mode: 'production',
      },
    );

    let output = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<x-custom stddeviation="0.5"'));
    assert(
      output.includes(
        '<svg preserveAspectRatio="xMinYMin meet" role="img" viewBox=',
      ),
    );
    assert(output.includes('<filter'));
    assert(output.includes('<feGaussianBlur in="SourceGraphic" stdDeviation='));
  });

  it('should throw error with empty string reference to other resource', async function () {
    await assert.rejects(
      () =>
        bundle(
          path.join(__dirname, 'integration/html-empty-reference/index.html'),
          {
            mode: 'production',
          },
        ),
      {
        name: 'BuildError',
        diagnostics: [
          {
            message: "'src' should not be empty string",
            origin: '@parcel/transformer-html',
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  'integration/html-empty-reference/index.html',
                ),
                language: 'html',
                codeHighlights: [
                  {
                    start: {
                      column: 1,
                      line: 1,
                    },
                    end: {
                      column: 14,
                      line: 1,
                    },
                  },
                ],
              },
            ],
          },

          {
            message: "'src' should not be empty string",
            origin: '@parcel/transformer-html',
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  'integration/html-empty-reference/index.html',
                ),
                language: 'html',
                codeHighlights: [
                  {
                    start: {
                      column: 1,
                      line: 2,
                    },
                    end: {
                      column: 24,
                      line: 2,
                    },
                  },
                ],
              },
            ],
          },

          {
            message: "'href' should not be empty string",
            origin: '@parcel/transformer-html',
            codeFrames: [
              {
                filePath: path.join(
                  __dirname,
                  'integration/html-empty-reference/index.html',
                ),
                language: 'html',
                codeHighlights: [
                  {
                    start: {
                      column: 1,
                      line: 3,
                    },
                    end: {
                      column: 16,
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

  it('extracts shared bundles that load referenced bundle roots across entries', async () => {
    let b = await bundle(
      ['index1.html', 'index2.html'].map(entry =>
        path.join(__dirname, 'integration/html-shared-referenced', entry),
      ),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
        },
      },
    );

    await run(b);
  });

  it('should not skip bundleRoots if an asset is both async required and static required', async function () {
    let b = await bundle(
      path.join(__dirname, 'integration/html-sync-async-asset/index.html'),
      {
        mode: 'production',
        defaultTargetOptions: {
          shouldOptimize: false,
        },
      },
    );

    await run(b, {output: null}, {require: false});
  });

  it('should insert bundle manifest into the correct bundle with multiple script tags', async function () {
    const dir = path.join(__dirname, 'manifest-multi-script');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
        index.html:
          <body>
            <script src="./polyfills.js" type="module"></script>
            <script src="./main.js" type="module"></script>
          </body>

        polyfills.js:
          import('./polyfills-async');
        polyfills-async.js:
          export const foo = 2;
        main.js:
          import('./main-async');
        main-async.js:
          export const bar = 3;
        `;

    let b = await bundle(path.join(dir, '/index.html'), {
      inputFS: overlayFS,
    });

    // Should not error with "Cannot find module" error at runtime.
    await run(b);
  });

  describe('import maps', function () {
    let dir;
    let count = 0;
    beforeEach(async () => {
      dir = path.join(__dirname, 'html-import-maps-' + ++count);
      await overlayFS.mkdirp(dir);
    });

    it('should generate an import map', async function () {
      await fsFixture(overlayFS, dir)`
        index.html:
          <body>
            <script src="./main.js" type="module"></script>
          </body>
        main.js:
          globalThis.output = async () => (await import('./main-async')).bar();
        main-async.js:
          import './main-async.css';
          export const bar = async () => (await import('./nested-async')).bar + 3;
        main-async.css:
          .foo { color: red }
        nested-async.js:
          import './nested-async.css';
          export const bar = 4;
        nested-async.css:
          .bar { color: green }
        `;

      let b = await bundle(path.join(dir, '/index.html'), {
        inputFS: overlayFS,
        mode: 'production',
      });

      let html = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
      let importMap = JSON.parse(
        html.match(/<script type="importmap">(.*?)<\/script>/)[1],
      );
      assert.deepEqual(importMap, {
        imports: {
          [b.getBundles()[2].publicId]:
            '/' + path.basename(b.getBundles()[2].filePath),
          [b.getBundles()[3].publicId]:
            '/' + path.basename(b.getBundles()[3].filePath),
          [b.getBundles()[4].publicId]:
            '/' + path.basename(b.getBundles()[4].filePath),
          [b.getBundles()[5].publicId]:
            '/' + path.basename(b.getBundles()[5].filePath),
        },
      });

      assert(
        html.indexOf('<script type="importmap">') < html.indexOf('<script src'),
      );

      let res = await run(b, null, {require: false});
      let value = await res.output();
      assert.equal(value, 7);
    });

    it('should merge with an existing import map', async function () {
      await fsFixture(overlayFS, dir)`
        index.html:
          <body>
            <script type="importmap">
              {"imports": {"react": "https://esm.sh/react@18.2.0"}}
            </script>
            <script type="module" src="./main.js"></script>
          </body>
        main.js:
          globalThis.output = async () => (await import('./main-async')).bar;
        main-async.js:
          export const bar = 3;
        `;

      let b = await bundle(path.join(dir, '/index.html'), {
        inputFS: overlayFS,
        mode: 'production',
      });

      let html = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
      let importMap = JSON.parse(
        html.match(/<script type="importmap">(.*?)<\/script>/)[1],
      );
      assert.deepEqual(importMap, {
        imports: {
          react: 'https://esm.sh/react@18.2.0',
          [b.getBundles()[2].publicId]:
            '/' + path.basename(b.getBundles()[2].filePath),
        },
      });

      assert(
        html.indexOf('<script type="importmap">') <
          html.indexOf('<script type="module"'),
      );

      let res = await run(b, null, {require: false});
      let value = await res.output();
      assert.equal(value, 3);
    });

    it('should merge with an existing import map with shared bundles', async function () {
      await fsFixture(overlayFS, dir)`
        index.html:
          <html>
            <body>
              <script type="importmap">
                {"imports": {"react": "https://esm.sh/react@18.2.0"}}
              </script>
              <script type="module" src="./main.js"></script>
            </body>
          </html>
        main.js:
          import 'lodash';
          globalThis.output = async () => (await import('./main-async')).bar;
        main-async.js:
          export const bar = 3;
        other.html:
          <script type="module" src="./other.js"></script>
        other.js:
          import 'lodash';
        `;

      let b = await bundle(path.join(dir, '/*.html'), {
        inputFS: overlayFS,
        mode: 'production',
      });

      let html = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
      let importMap = JSON.parse(
        html.match(/<script type="importmap">(.*?)<\/script>/)[1],
      );
      assert.deepEqual(importMap, {
        imports: {
          react: 'https://esm.sh/react@18.2.0',
          [b.getBundles()[2].publicId]:
            '/' + path.basename(b.getBundles()[2].filePath),
        },
      });

      assert(
        html.indexOf('<script type="importmap">') <
          html.indexOf('<script type="module"'),
      );

      let res = await run(b, null, {require: false});
      let value = await res.output();
      assert.equal(value, 3);
    });
  });
});
