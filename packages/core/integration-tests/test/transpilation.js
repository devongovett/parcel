// @flow
import assert from 'assert';
import path from 'path';
import {
  bundle,
  distDir,
  inputFS as fs,
  outputFS,
  overlayFS,
  run,
  ncp,
} from '@parcel/test-utils';
import {symlinkSync} from 'fs';
import nullthrows from 'nullthrows';

const inputDir = path.join(__dirname, '/input');

describe('transpilation', function () {
  it('should not transpile if no targets are defined', async function () {
    await bundle(path.join(__dirname, '/integration/babel-default/index.js'), {
      defaultTargetOptions: {
        engines: undefined,
        shouldOptimize: false,
      },
    });
    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('class Foo'));
    assert(file.includes('class Bar'));
  });

  it('should support transpiling using browserlist', async function () {
    await bundle(
      path.join(__dirname, '/integration/babel-browserslist/index.js'),
    );

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('function Foo'));
    assert(file.includes('function Bar'));
  });

  it('should support transpiling when engines have semver ranges', async () => {
    let fixtureDir = path.join(__dirname, '/integration/babel-semver-engine');
    await bundle(path.join(fixtureDir, 'index.js'));

    let legacy = await outputFS.readFile(
      path.join(fixtureDir, 'dist', 'legacy.js'),
      'utf8',
    );
    assert(legacy.includes('function Foo'));
    assert(legacy.includes('function Bar'));

    let modern = await outputFS.readFile(
      path.join(fixtureDir, 'dist', 'modern.js'),
      'utf8',
    );
    assert(modern.includes('class Foo'));
    assert(modern.includes('class Bar'));
  });

  it('should transpile node_modules by default', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/babel-node-modules/index.js'),
    );

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(!/class \S+ \{/.test(file));
    assert(file.includes('function Bar'));
    let res = await run(b);
    assert.equal(res.t, 'function');
  });

  it('should not support JSX in node_modules', async function () {
    // $FlowFixMe
    await assert.rejects(() =>
      bundle(
        path.join(__dirname, '/integration/babel-node-modules-jsx/index.js'),
      ),
    );
  });

  it('should compile node_modules with a source field in package.json when not symlinked', async function () {
    await bundle(
      path.join(
        __dirname,
        '/integration/babel-node-modules-source-unlinked/index.js',
      ),
    );

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('function Foo'));
    assert(file.includes('function Bar'));
  });

  it('should support compiling JSX', async function () {
    await bundle(path.join(__dirname, '/integration/jsx/index.jsx'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('React.createElement("div"'));
    assert(file.includes('fileName: "integration/jsx/index.jsx"'));
  });

  it('should support compiling JSX correctly with member expression type', async function () {
    await bundle(path.join(__dirname, '/integration/jsx-member/index.jsx'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('React.createElement(S.Foo'));
  });

  it('should support compiling JSX in JS files with React dependency', async function () {
    await bundle(path.join(__dirname, '/integration/jsx-react/index.js'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('React.createElement("div"'));
  });

  it('should support compiling JSX with pure annotations', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-react/pure-comment.js'),
    );

    let file = await outputFS.readFile(
      path.join(distDir, 'pure-comment.js'),
      'utf8',
    );
    assert(
      file.includes('/*#__PURE__*/ (0, _reactDefault.default).createElement'),
    );

    let res = await run(b);
    assert(res.Foo());
  });

  it('should support compiling JSX in JS files with React aliased to Preact', async function () {
    await bundle(path.join(__dirname, '/integration/jsx-react-alias/index.js'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('React.createElement("div"'));
  });

  it('should support compiling JSX in JS files with Preact dependency', async function () {
    await bundle(path.join(__dirname, '/integration/jsx-preact/index.js'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('h("div"'));
  });

  it('should support compiling JSX in JS files with Preact url dependency', async function () {
    await bundle(
      path.join(__dirname, '/integration/jsx-preact-with-url/index.js'),
    );

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('h("div"'));
  });

  it('should support compiling JSX in TS files with Preact dependency', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-preact-ts/index.tsx'),
    );

    assert(typeof (await run(b)) === 'object');
  });

  it('should support compiling JSX in JS files with Nerv dependency', async function () {
    await bundle(path.join(__dirname, '/integration/jsx-nervjs/index.js'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('Nerv.createElement("div"'));
  });

  it('should support compiling JSX in JS files with Hyperapp dependency', async function () {
    await bundle(path.join(__dirname, '/integration/jsx-hyperapp/index.js'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    assert(file.includes('h("div"'));
  });

  it('should not transpile spread in JSX with modern targets', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-spread/index.jsx'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('React.createElement("div"'));
    assert(file.includes('...a'));
    assert(!file.includes('@swc/helpers'));
  });

  it('should support the automatic JSX runtime with React >= 17', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-automatic/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('react/jsx-dev-runtime'));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support the automatic JSX runtime with preact >= 10.5', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-automatic-preact/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('preact/jsx-dev-runtime'));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support the automatic JSX runtime with React ^16.14.0', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-automatic-16/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('react/jsx-dev-runtime'));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support the automatic JSX runtime with React 18 prereleases', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-automatic-18/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('react/jsx-dev-runtime'));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support the automatic JSX runtime with experimental React versions', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-automatic-experimental/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('react/jsx-dev-runtime'));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support the automatic JSX runtime with preact with alias', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/jsx-automatic-preact-with-alias/index.js',
      ),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(/\Wreact\/jsx-dev-runtime\W/.test(file));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support the automatic JSX runtime with explicit tsconfig.json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-automatic-tsconfig/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('preact/jsx-dev-runtime'));
    assert(file.includes('(0, _jsxDevRuntime.jsxDEV)("div"'));
  });

  it('should support explicit JSX pragma in tsconfig.json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-pragma-tsconfig/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('JSX(JSXFragment'));
    assert(file.includes('JSX("div"'));
  });

  it('should support explicitly enabling JSX in tsconfig.json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/jsx-tsconfig/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('React.createElement("div"'));
  });

  it('should support enabling decorators in tsconfig.json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/decorators/index.ts'),
    );

    let output = [];
    await run(b, {
      output(o) {
        output.push(o);
      },
    });

    assert.deepEqual(output, [
      'first(): factory evaluated',
      'second(): factory evaluated',
      'second(): called',
      'first(): called',
    ]);
  });

  it('should support enabling decorators and setting useDefineForClassFields in tsconfig.json', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/decorators-useDefineForClassFields/index.ts',
      ),
    );

    let output = [];
    await run(b, {
      output(...o) {
        output.push(...o);
      },
    });

    assert.deepEqual(output, ['foo 15', 'foo 16']);
  });

  it('should support transpiling optional chaining', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/babel-optional-chaining/index.js'),
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(!file.includes('?.'));

    let output = await run(b);
    assert.equal(typeof output, 'object');
    assert.deepEqual(output.default, [undefined, undefined]);
  });

  it('should only include necessary parts of core-js using browserlist', async function () {
    await bundle(path.join(__dirname, '/integration/babel-core-js/index.js'));

    let file = await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8');
    // console.log(file)
    assert(file.includes('async function Bar() {'));
    // Check that core-js's globalThis polyfill is referenced.
    // NOTE: This may change if core-js internals change.
    assert(file.includes('esnext.global-this'));
    assert(!file.includes('es.array.concat'));
  });

  it('should resolve @swc/helpers and regenerator-runtime relative to parcel', async function () {
    let dir = path.join('/tmp/' + Math.random().toString(36).slice(2));
    await outputFS.mkdirp(dir);
    await ncp(path.join(__dirname, '/integration/swc-helpers'), dir);
    await bundle(path.join(dir, 'index.js'), {
      mode: 'production',
      inputFS: overlayFS,
      defaultTargetOptions: {
        engines: {
          browsers: '>= 0.25%',
        },
      },
    });
  });

  it('should support commonjs and esm versions of @swc/helpers', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/swc-helpers-library/index.js'),
    );

    let file = await outputFS.readFile(
      nullthrows(b.getBundles().find(b => b.env.outputFormat === 'commonjs'))
        .filePath,
      'utf8',
    );
    assert(file.includes('@swc/helpers/cjs/_class_call_check.cjs'));

    file = await outputFS.readFile(
      nullthrows(b.getBundles().find(b => b.env.outputFormat === 'esmodule'))
        .filePath,
      'utf8',
    );
    assert(file.includes('@swc/helpers/_/_class_call_check'));
  });

  it('should support commonjs versions of @swc/helpers without scope hoisting', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/swc-helpers-library/index.js'),
      {
        targets: {
          test: {
            distDir,
            isLibrary: true,
            scopeHoist: false,
          },
        },
      },
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(file.includes('@swc/helpers/cjs/_class_call_check.cjs'));
    await run(b);
  });

  it('should print errors from transpilation', async function () {
    let source = path.join(
      __dirname,
      '/integration/transpilation-invalid/index.js',
    );
    // $FlowFixMe
    await assert.rejects(() => bundle(source), {
      name: 'BuildError',
      diagnostics: [
        {
          codeFrames: [
            {
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    column: 1,
                    line: 1,
                  },
                  end: {
                    column: 12,
                    line: 1,
                  },
                },
              ],
              filePath: source,
            },
          ],
          hints: null,
          message: 'pragma cannot be set when runtime is automatic',
          origin: '@parcel/transformer-js',
        },
        {
          codeFrames: [
            {
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    column: 3,
                    line: 9,
                  },
                  end: {
                    column: 4,
                    line: 9,
                  },
                },
              ],
              filePath: source,
            },
          ],
          hints: null,
          message: 'duplicate private name #x.',
          origin: '@parcel/transformer-js',
        },
      ],
    });
  });

  describe('tests needing the real filesystem', () => {
    afterEach(async () => {
      if (process.platform === 'win32') {
        return;
      }

      try {
        await fs.rimraf(inputDir);
        await fs.rimraf(distDir);
      } catch (e) {
        // ignore
      }
    });

    it('should compile node_modules when symlinked with a source field in package.json', async function () {
      if (process.platform === 'win32') {
        this.skip();
        return;
      }

      const inputDir = path.join(__dirname, '/input');
      await fs.rimraf(inputDir);
      await fs.mkdirp(path.join(inputDir, 'node_modules'));
      await fs.ncp(
        path.join(
          path.join(__dirname, '/integration/babel-node-modules-source'),
        ),
        inputDir,
      );

      // Create the symlink here to prevent cross platform and git issues
      symlinkSync(
        path.join(inputDir, 'packages/foo'),
        path.join(inputDir, 'node_modules/foo'),
        'dir',
      );

      await bundle(inputDir + '/index.js', {outputFS: fs});

      let file = await fs.readFile(path.join(distDir, 'index.js'), 'utf8');
      assert(file.includes('function Foo'));
      assert(file.includes('function Bar'));
    });
  });
});
