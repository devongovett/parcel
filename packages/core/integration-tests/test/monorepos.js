import assert from 'assert';
import path from 'path';
import {
  bundle,
  bundler,
  assertBundles,
  inputFS,
  outputFS,
  fsFixture,
  ncp,
  run,
  overlayFS,
  getNextBuild,
  runBundle,
} from '@parcel/test-utils';

const distDir = path.join(__dirname, '/integration/monorepo/dist/default');

describe('monorepos', function () {
  beforeEach(async () => {
    await outputFS.rimraf(path.join(__dirname, '/monorepo'));
  });

  let subscription;
  afterEach(async () => {
    if (subscription) {
      await subscription.unsubscribe();
      subscription = null;
    }
  });

  it('should compile packages with target source overrides', async function () {
    let fixture = path.join(__dirname, '/integration/target-source');
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(
        [
          path.join(fixture, 'packages/package-a'),
          path.join(fixture, 'packages/package-b'),
        ],
        {
          defaultTargetOptions: {
            shouldScopeHoist: true,
            distDir,
          },
        },
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['foo.js', 'index.js'],
        },
        {
          name: 'indexAlternate.js',
          assets: ['bar.js', 'indexAlternate.js'],
        },
        {
          name: 'index.js',
          assets: ['foo.js', 'index.js'],
        },
        {
          name: 'indexAlternate.js',
          assets: ['bar.js', 'indexAlternate.js'],
        },
        {
          name: 'indexAlternate2.js',
          assets: ['foo.js', 'indexAlternate2.js'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(distDir, '/package-a/src/index.js'),
        'utf8',
      );
      assert(contents.includes('hello foo'));

      contents = await outputFS.readFile(
        path.join(distDir, '/package-a/src/indexAlternate.js'),
        'utf8',
      );
      assert(contents.includes('hello bar'));

      contents = await outputFS.readFile(
        path.join(distDir, '/package-a/src/indexAlternate2.js'),
        'utf8',
      );
      assert(contents.includes('hello foo'));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should compile packages with target source overrides and --target option', async function () {
    let fixture = path.join(__dirname, '/integration/target-source');
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(
        [
          path.join(fixture, 'packages/package-a'),
          path.join(fixture, 'packages/package-b'),
        ],
        {
          targets: ['alternate'],
          defaultTargetOptions: {
            shouldScopeHoist: true,
            distDir,
          },
        },
      );

      assertBundles(b, [
        {
          name: 'indexAlternate.js',
          assets: ['bar.js', 'indexAlternate.js'],
        },
        {
          name: 'indexAlternate.js',
          assets: ['bar.js', 'indexAlternate.js'],
        },
        {
          name: 'indexAlternate2.js',
          assets: ['foo.js', 'indexAlternate2.js'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(distDir, '/package-a/src/indexAlternate.js'),
        'utf8',
      );
      assert(contents.includes('hello bar'));

      contents = await outputFS.readFile(
        path.join(distDir, '/package-a/src/indexAlternate2.js'),
        'utf8',
      );
      assert(contents.includes('hello foo'));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should compile packages with target source overrides and --target option in serve mode', async function () {
    let fixture = path.join(__dirname, '/integration/target-source');
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(path.join(fixture, 'packages/package-b'), {
        targets: ['alternate'],
        serveOptions: {port: 1234},
      });

      assertBundles(b, [
        {
          name: 'indexAlternate.js',
          assets: ['bar.js', 'esmodule-helpers.js', 'indexAlternate.js'],
        },
      ]);
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should build using root targets with entry files inside packages and cwd at project root', async function () {
    let fixture = path.join(__dirname, '/integration/monorepo');
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(
        [
          path.join(fixture, 'packages/pkg-a/src/index.js'),
          path.join(fixture, 'packages/pkg-b/src/index.js'),
        ],
        {
          defaultTargetOptions: {
            shouldScopeHoist: true,
            distDir,
          },
        },
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js'],
        },
        {
          name: 'index.js',
          assets: ['index.js', 'index.module.css'],
        },
        {
          name: 'index.css',
          assets: ['index.module.css'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(distDir, '/pkg-a/src/index.js'),
        'utf8',
      );
      assert(contents.includes('$parcel$export(module.exports, "default"'));

      contents = await outputFS.readFile(
        path.join(distDir, '/pkg-b/src/index.js'),
        'utf8',
      );
      assert(contents.includes('require("./index.css")'));

      contents = await outputFS.readFile(
        path.join(distDir, '/pkg-b/src/index.css'),
        'utf8',
      );
      assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should build multiple packages in a monorepo at once, pointing at directories with "source" field in package.json', async function () {
    let b = await bundle(
      [
        path.join(__dirname, '/integration/monorepo/packages/pkg-a'),
        path.join(__dirname, '/integration/monorepo/packages/pkg-b'),
      ],
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-b.cjs.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.module.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.cjs.css',
        assets: ['index.module.css'],
      },
      {
        name: 'pkg-b.module.css',
        assets: ['index.module.css'],
      },
    ]);

    let contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-a/dist/pkg-a.cjs.js',
      ),
      'utf8',
    );
    assert(contents.includes('$parcel$export(module.exports, "default"'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-a/dist/pkg-a.module.js',
      ),
      'utf8',
    );
    assert(contents.includes('export {'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-b/dist/pkg-b.cjs.js',
      ),
      'utf8',
    );
    assert(contents.includes('require("./pkg-b.cjs.css")'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-b/dist/pkg-b.cjs.css',
      ),
      'utf8',
    );
    assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-b/dist/pkg-b.module.js',
      ),
      'utf8',
    );
    assert(contents.includes('import "./pkg-b.module.css"'));
  });

  it('should build using root targets with a glob pointing at files inside packages and cwd at project root', async function () {
    let fixture = path.join(__dirname, '/integration/monorepo');
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(path.join(fixture, 'packages/*/src/index.js'), {
        defaultTargetOptions: {
          shouldScopeHoist: true,
          distDir,
        },
      });

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js'],
        },
        {
          name: 'index.js',
          assets: ['index.js', 'index.module.css'],
        },
        {
          name: 'index.css',
          assets: ['index.module.css'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(distDir, '/pkg-a/src/index.js'),
        'utf8',
      );
      assert(contents.includes('$parcel$export(module.exports, "default"'));

      contents = await outputFS.readFile(
        path.join(distDir, '/pkg-b/src/index.js'),
        'utf8',
      );
      assert(contents.includes('require("./index.css")'));

      contents = await outputFS.readFile(
        path.join(distDir, '/pkg-b/src/index.css'),
        'utf8',
      );
      assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should build using root targets with a glob pointing at files inside packages and cwd outside project root', async function () {
    let oldcwd = inputFS.cwd();
    inputFS.chdir(path.join(__dirname, '/integration'));

    try {
      let b = await bundle(
        path.join(__dirname, '/integration/monorepo/packages/*/src/index.js'),
        {
          defaultTargetOptions: {
            shouldScopeHoist: true,
            distDir,
          },
        },
      );

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js'],
        },
        {
          name: 'index.js',
          assets: ['index.js', 'index.module.css'],
        },
        {
          name: 'index.css',
          assets: ['index.module.css'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(distDir, '/pkg-a/src/index.js'),
        'utf8',
      );
      assert(contents.includes('$parcel$export(module.exports, "default"'));

      contents = await outputFS.readFile(
        path.join(distDir, '/pkg-b/src/index.js'),
        'utf8',
      );
      assert(contents.includes('require("./index.css")'));

      contents = await outputFS.readFile(
        path.join(distDir, '/pkg-b/src/index.css'),
        'utf8',
      );
      assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should build a single package with an entry file and cwd at a package', async function () {
    let fixture = path.join(__dirname, '/integration/monorepo/packages/pkg-a');
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(path.join(fixture, 'src/index.js'), {
        defaultTargetOptions: {
          shouldScopeHoist: true,
          distDir,
        },
      });

      assertBundles(b, [
        {
          name: 'pkg-a.cjs.js',
          assets: ['index.js'],
        },
        {
          name: 'pkg-a.module.js',
          assets: ['index.js'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(
          __dirname,
          '/integration/monorepo/packages/pkg-a/dist/pkg-a.cjs.js',
        ),
        'utf8',
      );
      assert(contents.includes('$parcel$export(module.exports, "default"'));

      contents = await outputFS.readFile(
        path.join(
          __dirname,
          '/integration/monorepo/packages/pkg-a/dist/pkg-a.module.js',
        ),
        'utf8',
      );
      assert(contents.includes('export {'));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should build a single package with an entry file and cwd inside a package', async function () {
    let fixture = path.join(
      __dirname,
      '/integration/monorepo/packages/pkg-a/src',
    );
    let oldcwd = inputFS.cwd();
    inputFS.chdir(fixture);

    try {
      let b = await bundle(path.join(fixture, 'index.js'), {
        defaultTargetOptions: {
          shouldScopeHoist: true,
          distDir,
        },
      });

      assertBundles(b, [
        {
          name: 'pkg-a.cjs.js',
          assets: ['index.js'],
        },
        {
          name: 'pkg-a.module.js',
          assets: ['index.js'],
        },
      ]);

      let contents = await outputFS.readFile(
        path.join(
          __dirname,
          '/integration/monorepo/packages/pkg-a/dist/pkg-a.cjs.js',
        ),
        'utf8',
      );
      assert(contents.includes('$parcel$export(module.exports, "default"'));

      contents = await outputFS.readFile(
        path.join(
          __dirname,
          '/integration/monorepo/packages/pkg-a/dist/pkg-a.module.js',
        ),
        'utf8',
      );
      assert(contents.includes('export {'));
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  it('should build multiple packages in a monorepo at once, pointing at a glob of directories', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/monorepo/packages/*'),
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-b.cjs.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.module.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.cjs.css',
        assets: ['index.module.css'],
      },
      {
        name: 'pkg-b.module.css',
        assets: ['index.module.css'],
      },
    ]);

    let contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-a/dist/pkg-a.cjs.js',
      ),
      'utf8',
    );
    assert(contents.includes('$parcel$export(module.exports, "default"'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-a/dist/pkg-a.module.js',
      ),
      'utf8',
    );
    assert(contents.includes('export {'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-b/dist/pkg-b.cjs.js',
      ),
      'utf8',
    );
    assert(contents.includes('require("./pkg-b.cjs.css")'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-b/dist/pkg-b.cjs.css',
      ),
      'utf8',
    );
    assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo/packages/pkg-b/dist/pkg-b.module.js',
      ),
      'utf8',
    );
    assert(contents.includes('import "./pkg-b.module.css"'));
  });

  it('should watch glob entries and build new packages that are added', async function () {
    // copy into memory fs
    await ncp(
      path.join(__dirname, '/integration/monorepo/packages/pkg-a'),
      path.join(__dirname, '/monorepo/packages/pkg-a'),
    );

    let b = await bundler(path.join(__dirname, '/monorepo/packages/*'), {
      defaultTargetOptions: {
        shouldScopeHoist: true,
      },
      inputFS: overlayFS,
    });

    subscription = await b.watch();
    let evt = await getNextBuild(b);

    assertBundles(evt.bundleGraph, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js'],
      },
    ]);

    await ncp(
      path.join(__dirname, '/integration/monorepo/packages/pkg-b'),
      path.join(__dirname, '/monorepo/packages/pkg-b'),
    );

    evt = await getNextBuild(b);
    assertBundles(evt.bundleGraph, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-b.cjs.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.module.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.cjs.css',
        assets: ['index.module.css'],
      },
      {
        name: 'pkg-b.module.css',
        assets: ['index.module.css'],
      },
    ]);
  });

  it('should watch package.json containing "source" field for changes', async function () {
    // copy into memory fs
    await ncp(
      path.join(__dirname, '/integration/monorepo/packages/pkg-a'),
      path.join(__dirname, '/monorepo/packages/pkg-a'),
    );

    let b = await bundler(path.join(__dirname, '/monorepo/packages/*'), {
      defaultTargetOptions: {
        shouldScopeHoist: true,
      },
      inputFS: overlayFS,
    });

    subscription = await b.watch();
    let evt = await getNextBuild(b);

    assertBundles(evt.bundleGraph, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js'],
      },
    ]);

    let pkgFile = path.join(__dirname, '/monorepo/packages/pkg-a/package.json');
    let pkg = JSON.parse(await outputFS.readFile(pkgFile, 'utf8'));
    await outputFS.writeFile(
      pkgFile,
      JSON.stringify({...pkg, source: 'src/alt.js'}),
    );

    evt = await getNextBuild(b);
    assert(evt.type === 'buildSuccess');
    assertBundles(evt.bundleGraph, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['alt.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['alt.js'],
      },
    ]);

    let contents = await outputFS.readFile(
      path.join(__dirname, '/monorepo/packages/pkg-a/dist/pkg-a.cjs.js'),
      'utf8',
    );
    assert(contents.includes('return 3'));

    contents = await outputFS.readFile(
      path.join(__dirname, '/monorepo/packages/pkg-a/dist/pkg-a.module.js'),
      'utf8',
    );
    assert(contents.includes('return 3'));
  });

  it('should watch package.json containing targets for changes', async function () {
    // copy into memory fs
    await ncp(
      path.join(__dirname, '/integration/monorepo/packages/pkg-a'),
      path.join(__dirname, '/monorepo/packages/pkg-a'),
    );

    let b = await bundler(path.join(__dirname, '/monorepo/packages/*'), {
      defaultTargetOptions: {
        shouldScopeHoist: true,
      },
      inputFS: overlayFS,
    });

    subscription = await b.watch();
    let evt = await getNextBuild(b);

    assertBundles(evt.bundleGraph, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js'],
      },
    ]);

    let pkgFile = path.join(__dirname, '/monorepo/packages/pkg-a/package.json');
    let pkg = JSON.parse(await outputFS.readFile(pkgFile, 'utf8'));
    await outputFS.writeFile(
      pkgFile,
      JSON.stringify({
        ...pkg,
        main: 'dist/alt.js',
        module: 'dist/alt.module.js',
      }),
    );

    evt = await getNextBuild(b);
    assertBundles(evt.bundleGraph, [
      {
        name: 'alt.js',
        assets: ['index.js'],
      },
      {
        name: 'alt.module.js',
        assets: ['index.js'],
      },
    ]);

    let contents = await outputFS.readFile(
      path.join(__dirname, '/monorepo/packages/pkg-a/dist/alt.js'),
      'utf8',
    );
    assert(contents.includes('return 2'));

    contents = await outputFS.readFile(
      path.join(__dirname, '/monorepo/packages/pkg-a/dist/alt.module.js'),
      'utf8',
    );
    assert(contents.includes('return 2'));
  });

  it('should not share bundles between targets', async function () {
    let b = await bundle(
      [
        path.join(__dirname, '/integration/monorepo-shared/packages/pkg-a'),
        path.join(__dirname, '/integration/monorepo-shared/packages/pkg-b'),
      ],
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
    );

    assertBundles(b, [
      {
        name: 'pkg-a.cjs.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-a.module.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-a.cjs.css',
        assets: ['index.module.css'],
      },
      {
        name: 'pkg-a.module.css',
        assets: ['index.module.css'],
      },
      {
        name: 'pkg-b.cjs.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.module.js',
        assets: ['index.js', 'index.module.css'],
      },
      {
        name: 'pkg-b.cjs.css',
        assets: ['index.module.css'],
      },
      {
        name: 'pkg-b.module.css',
        assets: ['index.module.css'],
      },
    ]);

    let contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo-shared/packages/pkg-a/dist/pkg-a.cjs.js',
      ),
      'utf8',
    );
    assert(contents.includes('$parcel$export(module.exports, "default"'));
    assert(contents.includes('require("./pkg-a.cjs.css")'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo-shared/packages/pkg-a/dist/pkg-a.module.js',
      ),
      'utf8',
    );
    assert(contents.includes('export {'));
    assert(contents.includes('import "./pkg-a.module.css"'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo-shared/packages/pkg-a/dist/pkg-a.cjs.css',
      ),
      'utf8',
    );
    assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo-shared/packages/pkg-b/dist/pkg-b.cjs.js',
      ),
      'utf8',
    );
    assert(contents.includes('require("./pkg-b.cjs.css")'));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo-shared/packages/pkg-b/dist/pkg-b.cjs.css',
      ),
      'utf8',
    );
    assert(/\.[_0-9a-zA-Z]+_foo/.test(contents));

    contents = await outputFS.readFile(
      path.join(
        __dirname,
        '/integration/monorepo-shared/packages/pkg-b/dist/pkg-b.module.js',
      ),
      'utf8',
    );
    assert(contents.includes('import "./pkg-b.module.css"'));
  });

  it('should search for .parcelrc at cwd in monorepos', async () => {
    let fixture = path.join(
      __dirname,
      '/integration/parcelrc-monorepo/app/index.js',
    );

    let oldcwd = inputFS.cwd();
    inputFS.chdir(path.dirname(fixture));

    try {
      let b = await bundle(fixture);

      assert.equal((await run(b)).default, '<svg></svg>\n');
    } finally {
      inputFS.chdir(oldcwd);
    }
  });

  // This test ensures that workspace linked dependency changes are correctly
  // detected in watch mode when `watchDir` is set to the monorepo root.
  it('should correctly detect changes when watchDir is higher up in a project-only lockfile monorepo', async () => {
    const dir = path.join(__dirname, 'project-specific-lockfiles');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      packages
        app
          package.json:
            { "name": "app" }
          pnpm-lock.yaml:
            lockfileVersion: 5.4
          index.js:
            import {msg} from 'lib';
            console.log(msg);
          node_modules
            lib -> ${path.join(
              __dirname,
              'project-specific-lockfiles',
              'packages',
              'lib',
            )}
        lib
          package.json:
            { "name": "lib" }
          pnpm-lock.yaml:
            lockfileVersion: 5.4
          index.js:
            export const msg = "initial";`;

    let b = await bundler(path.join(dir, 'packages', 'app', 'index.js'), {
      inputFS: overlayFS,
      watchDir: path.join(dir),
    });

    let builds = 0;

    return new Promise((resolve, reject) => {
      // 1. Increment the build counter and modify `packages/lib/index.js` which
      //    should trigger a subsquent build.
      //
      // 2. Ensure the changed asset was detected and built
      b.watch(async (err, buildEvent) => {
        builds++;

        if (builds < 2) {
          await overlayFS.writeFile(
            path.join(dir, 'packages', 'lib', 'index.js'),
            'export const msg = "changed-NcMB9nA7"',
          );
        } else {
          const values = buildEvent?.changedAssets?.values();
          if (values != null) {
            const code = await Array.from(values)[0].getCode();
            assert(code.includes('changed-NcMB9nA7'));
            resolve();
          } else {
            reject(new Error('Changed assets missing.'));
          }
        }
      }).then(sub => {
        subscription = sub;
      });
    });
  });

  it('should support globs in the source field', async function () {
    const dir = path.join(__dirname, 'source-glob');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      yarn.lock:

      package.json:
        {
          "source": "foo/*.js",
          "targets": {
            "default": {
              "outputFormat": "esmodule",
              "isLibrary": true
            }
          }
        }

      foo/a.js:
        export default 'a';

      foo/b.js:
        export default 'b';
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
    ]);

    for (let bundle of b.getBundles()) {
      let res = await runBundle(b, bundle);
      assert.equal(res.default, bundle.name[0]);
    }
  });

  it('should support multiple globs in the source field', async function () {
    const dir = path.join(__dirname, 'source-glob');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      yarn.lock:

      package.json:
        {
          "source": ["foo/*.js", "bar/*.js"],
          "targets": {
            "default": {
              "outputFormat": "esmodule",
              "isLibrary": true
            }
          }
        }

      foo/a.js:
        export default 'a';

      foo/b.js:
        export default 'b';

      bar/c.js:
        export default 'c';

      bar/d.js:
        export default 'd';
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
        assets: ['c.js'],
      },
      {
        assets: ['d.js'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let res = await runBundle(b, bundle);
      assert.equal(res.default, bundle.name[4]);
    }
  });

  it('should support globs in target-specific source field', async function () {
    const dir = path.join(__dirname, 'source-target-glob');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      yarn.lock:

      package.json:
        {
          "targets": {
            "foo-esm": {
              "source": "foo/*.js",
              "outputFormat": "esmodule",
              "isLibrary": true
            },
            "foo-cjs": {
              "source": "foo/*.js",
              "outputFormat": "commonjs",
              "isLibrary": true
            }
          }
        }

      foo/a.js:
        export default 'a';

      foo/b.js:
        export default 'b';
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
        assets: ['a.js'],
      },
      {
        assets: ['b.js'],
      },
    ]);

    for (let bundle of b.getBundles()) {
      let res = await runBundle(b, bundle);
      assert.equal(res.default, bundle.name[0]);
    }
  });

  it('should watch globs in source field', async function () {
    const dir = path.join(__dirname, 'input', 'source-glob-watch');
    await overlayFS.mkdirp(dir);
    await inputFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      yarn.lock:

      package.json:
        {
          "source": "foo/*.js",
          "targets": {
            "default": {
              "outputFormat": "esmodule",
              "isLibrary": true
            }
          }
        }

      foo/a.js:
        export default 'a';
    `;

    let b = await bundler(dir, {
      inputFS: overlayFS,
    });

    subscription = await b.watch();
    let evt = await getNextBuild(b);

    assertBundles(evt.bundleGraph, [
      {
        assets: ['a.js'],
      },
    ]);

    await fsFixture(overlayFS, dir)`
      foo/b.js:
        export default 'b';
    `;

    evt = await getNextBuild(b);
    assertBundles(evt.bundleGraph, [
      {
        assets: ['a.js'],
      },
      {
        assets: ['b.js'],
      },
    ]);
  });
});
