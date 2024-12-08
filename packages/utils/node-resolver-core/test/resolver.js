// @flow strict-local
import NodeResolver from '../src/Wrapper';
import path from 'path';
import assert from 'assert';
import nullthrows from 'nullthrows';
import {ncp, overlayFS, outputFS} from '@parcel/test-utils';
import {loadConfig as configCache} from '@parcel/utils';
import {createEnvironment} from '@parcel/core/src/Environment';
import Environment from '@parcel/core/src/public/Environment';
import {DEFAULT_OPTIONS} from '@parcel/core/test/test-utils';

const rootDir = path.join(__dirname, 'fixture');

const NODE_ENV = new Environment(
  createEnvironment({
    context: 'node',
    includeNodeModules: false,
  }),
  DEFAULT_OPTIONS,
);

const NODE_INCLUDE_ENV = new Environment(
  createEnvironment({
    context: 'node',
    includeNodeModules: true,
  }),
  DEFAULT_OPTIONS,
);

const BROWSER_ENV = new Environment(
  createEnvironment({
    context: 'browser',
    includeNodeModules: true,
  }),
  DEFAULT_OPTIONS,
);

describe('resolver', function () {
  let resolver, prodResolver;

  beforeEach(async function () {
    await overlayFS.mkdirp(rootDir);
    await ncp(rootDir, rootDir);

    // Create the symlinks here to prevent cross platform and git issues
    await outputFS.symlink(
      path.join(rootDir, 'packages/source'),
      path.join(rootDir, 'node_modules/source'),
    );
    await outputFS.symlink(
      path.join(
        rootDir,
        'node_modules/.pnpm/source-pnpm@1.0.0/node_modules/source-pnpm',
      ),
      path.join(rootDir, 'node_modules/source-pnpm'),
    );
    await outputFS.symlink(
      path.join(rootDir, 'packages/source-alias'),
      path.join(rootDir, 'node_modules/source-alias'),
    );
    await outputFS.symlink(
      path.join(rootDir, 'packages/source-alias-glob'),
      path.join(rootDir, 'node_modules/source-alias-glob'),
    );
    await outputFS.symlink(
      path.join(rootDir, 'packages/source-exports'),
      path.join(rootDir, 'node_modules/source-exports'),
    );
    await outputFS.symlink(
      path.join(rootDir, 'bar.js'),
      path.join(rootDir, 'baz.js'),
    );
    await outputFS.symlink(
      path.join(rootDir, 'nested'),
      path.join(rootDir, 'symlinked-nested'),
    );

    resolver = new NodeResolver({
      fs: overlayFS,
      projectRoot: rootDir,
      mode: 'development',
      packageExports: true,
    });

    prodResolver = new NodeResolver({
      fs: overlayFS,
      projectRoot: rootDir,
      mode: 'production',
      packageExports: true,
    });

    configCache.clear();
  });

  function normalize(res) {
    return {
      filePath: res?.filePath,
      invalidateOnFileCreate:
        res?.invalidateOnFileCreate?.sort((a, b) => {
          let ax =
            a.filePath ??
            a.glob ??
            (a.aboveFilePath != null && a.fileName != null
              ? a.aboveFilePath + a.fileName
              : '');
          let bx =
            b.filePath ??
            b.glob ??
            (b.aboveFilePath != null && b.fileName != null
              ? b.aboveFilePath + b.fileName
              : '');
          return ax < bx ? -1 : 1;
        }) ?? [],
      invalidateOnFileChange: res?.invalidateOnFileChange?.sort() ?? [],
      sideEffects: res?.sideEffects ?? true,
    };
  }

  function check(resolved, expected) {
    assert.deepEqual(normalize(resolved), normalize(expected));
  }

  describe('file paths', function () {
    it('should resolve a relative path with an extension', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './bar.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve a relative path without an extension', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve an absolute path from the root module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'nested', 'test.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve an absolute path from a node_modules folder', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'foo', 'index.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve a tilde path from the root module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '~/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'nested', 'test.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve a tilde path from the root module without a slash', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '~bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'nested', 'test.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve a tilde path from a node_modules folder', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '~/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'foo', 'nested', 'baz.js'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'node_modules', 'foo', 'bar.js'),
      );
    });

    it('should resolve an index file in a directory', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './nested',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'nested', 'index.js'),
      );
    });

    it('should not resolve an index file in a directory for URL specifiers', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './nested',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(nullthrows(resolved).diagnostics, [
        {message: "Cannot load file './nested' in './'.", hints: []},
      ]);
    });

    it('should resolve a file with a question mark with CommonJS specifiers', async function () {
      // Windows filenames cannot contain question marks.
      if (process.platform === 'win32') {
        return;
      }

      await overlayFS.writeFile(path.join(rootDir, 'a?b.js'), '');

      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './a?b.js',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'a?b.js'));
    });

    it('should not resolve a file with a question mark with ESM specifiers', async function () {
      // Windows filenames cannot contain question marks.
      if (process.platform === 'win32') {
        return;
      }

      await overlayFS.writeFile(path.join(rootDir, 'a?b.js'), '');

      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './a?b.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(nullthrows(resolved).diagnostics, [
        {message: "Cannot load file './a' in './'.", hints: []},
      ]);
    });

    it('should resolve a file with an encoded question mark with ESM specifiers', async function () {
      // Windows filenames cannot contain question marks.
      if (process.platform === 'win32') {
        return;
      }

      await overlayFS.writeFile(path.join(rootDir, 'a?b.js'), '');

      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './a%3Fb.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'a?b.js'));
    });

    it('should not support percent encoding in CommonJS specifiers', async function () {
      // Windows filenames cannot contain question marks.
      if (process.platform === 'win32') {
        return;
      }

      await overlayFS.writeFile(path.join(rootDir, 'a?b.js'), '');

      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './a%3Fb.js',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(nullthrows(resolved).diagnostics, [
        {
          message: "Cannot load file './a%3Fb.js' in './'.",
          hints: ["Did you mean '__./a?b.js__'?"],
        },
      ]);
    });

    it('should support query params for ESM specifiers', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './nested?foo=bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'nested', 'index.js'),
      );
      // assert.deepEqual(nullthrows(resolved).query?.toString(), 'foo=bar');
    });

    it('should not support query params for CommonJS specifiers', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './nested?foo=bar',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(nullthrows(resolved).diagnostics, [
        {message: "Cannot load file './nested?foo=bar' in './'.", hints: []},
      ]);
    });
  });

  describe('builtins', function () {
    it('should resolve node builtin modules', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'zlib',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: require.resolve('browserify-zlib'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/browserify-zlib',
            aboveFilePath: rootDir,
          },
          {
            fileName: 'package.json',
            aboveFilePath: path.dirname(require.resolve('browserify-zlib/lib')),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          require.resolve('browserify-zlib/package.json'),
        ],
      });
    });

    it('Should be able to handle node: prefixes', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'node:zlib',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: require.resolve('browserify-zlib'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/browserify-zlib',
            aboveFilePath: rootDir,
          },
          {
            fileName: 'package.json',
            aboveFilePath: path.dirname(require.resolve('browserify-zlib/lib')),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          require.resolve('browserify-zlib/package.json'),
        ],
      });
    });

    it('should resolve unimplemented node builtin modules to an empty file', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'fs',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(__dirname, '..', 'src', '_empty.js'),
        sideEffects: undefined,
        query: undefined,
      });
    });

    it('should exclude node builtin modules with --target=node', async function () {
      let resolved = await resolver.resolve({
        env: NODE_ENV,
        filename: 'zlib',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {isExcluded: true});
    });

    it('should exclude the electron module in electron environments', async function () {
      let resolved = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'electron-main',
            isLibrary: true,
            includeNodeModules: true,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'electron',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
        sourcePath: path.join(rootDir, 'foo.js'),
      });

      check(resolved, {isExcluded: true});
    });
  });

  describe('node_modules', function () {
    it('should resolve a node_modules index.js', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'foo', 'index.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/foo',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'foo', 'package.json'),
        ],
      });
    });

    it('should resolve a node_modules package.main', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-main',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'package-main', 'main.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-main',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'package-main', 'package.json'),
        ],
      });
    });

    it('should resolve a node_modules package.module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-module',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-module',
          'module.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-module',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'package-module', 'package.json'),
        ],
      });
    });

    it('should resolve a node_modules package.browser main field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-browser',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser',
          'browser.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-browser',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'package-browser', 'package.json'),
        ],
      });
    });

    it('should not resolve a node_modules package.browser main field with --target=node', async function () {
      let resolved = await resolver.resolve({
        env: NODE_INCLUDE_ENV,
        filename: 'package-browser',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser',
          'main.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-browser',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'package-browser', 'package.json'),
        ],
      });
    });

    it('should fall back to index.js when it cannot find package.main', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-fallback',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-fallback',
          'index.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-fallback',
            aboveFilePath: rootDir,
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.cjs',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.mjs',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.jsx',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.ts',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.tsx',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.js',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js.json',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-fallback',
              'main.js/package.json',
            ),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-fallback',
            'package.json',
          ),
        ],
      });
    });

    it('should resolve a node_module package.main pointing to a directory', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-main-directory',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-main-directory',
          'nested',
          'index.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-main-directory',
            aboveFilePath: rootDir,
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested',
              'package.json',
            ),
          },
          {
            fileName: 'package.json',
            aboveFilePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.js',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.json',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.jsx',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.cjs',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.mjs',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.ts',
            ),
          },
          {
            filePath: path.join(
              rootDir,
              'node_modules',
              'package-main-directory',
              'nested.tsx',
            ),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-main-directory',
            'package.json',
          ),
        ],
      });
    });

    it('should resolve a file inside a node_modules folder', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'foo/nested/baz',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'foo', 'nested', 'baz.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/foo',
            aboveFilePath: rootDir,
          },
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'node_modules', 'foo', 'nested'),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'foo', 'package.json'),
        ],
      });
    });

    it('should resolve a scoped module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '@scope/pkg',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.resolve(rootDir, 'node_modules/@scope/pkg/index.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/@scope/pkg',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', '@scope', 'pkg', 'package.json'),
        ],
      });
    });

    it('should resolve a file inside a scoped module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '@scope/pkg/foo/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.resolve(rootDir, 'node_modules/@scope/pkg/foo/bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/@scope/pkg',
            aboveFilePath: rootDir,
          },
          {
            fileName: 'package.json',
            aboveFilePath: path.join(
              rootDir,
              'node_modules',
              '@scope',
              'pkg',
              'foo',
            ),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', '@scope', 'pkg', 'package.json'),
        ],
      });
    });

    describe('sideEffects: false', function () {
      it('should determine sideEffects correctly (file)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false/src/index.js',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.resolve(
            rootDir,
            'node_modules/side-effects-false/src/index.js',
          ),
          sideEffects: false,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/side-effects-false',
              aboveFilePath: rootDir,
            },
            {
              fileName: 'package.json',
              aboveFilePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-false',
                'src',
              ),
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-false',
              'package.json',
            ),
          ],
        });
      });

      it('should determine sideEffects correctly (extensionless file)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false/src/index',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.resolve(
            rootDir,
            'node_modules/side-effects-false/src/index.js',
          ),
          sideEffects: false,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/side-effects-false',
              aboveFilePath: rootDir,
            },
            {
              fileName: 'package.json',
              aboveFilePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-false',
                'src',
              ),
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-false',
              'package.json',
            ),
          ],
        });
      });

      it('should determine sideEffects correctly (sub folder)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false/src/',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.resolve(
            rootDir,
            'node_modules/side-effects-false/src/index.js',
          ),
          sideEffects: false,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/side-effects-false',
              aboveFilePath: rootDir,
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-false',
                'src',
                'package.json',
              ),
            },
            {
              aboveFilePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-false',
                'src',
              ),
              fileName: 'package.json',
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-false',
              'package.json',
            ),
          ],
        });
      });

      it('should determine sideEffects correctly (main field)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false/src/',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.resolve(
            rootDir,
            'node_modules/side-effects-false/src/index.js',
          ),
          sideEffects: false,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/side-effects-false',
              aboveFilePath: rootDir,
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-false',
                'src',
                'package.json',
              ),
            },
            {
              aboveFilePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-false',
                'src',
              ),
              fileName: 'package.json',
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-false',
              'package.json',
            ),
          ],
        });
      });

      it('should determine sideEffects correctly (main field exists in upward package)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-package-redirect-up/foo/bar',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.resolve(
            rootDir,
            'node_modules/side-effects-package-redirect-up/foo/real-bar.js',
          ),
          sideEffects: false,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/side-effects-package-redirect-up',
              aboveFilePath: rootDir,
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.js',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.json',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.jsx',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.cjs',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.mjs',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.ts',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-up',
                'foo',
                'bar.tsx',
              ),
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-package-redirect-up',
              'package.json',
            ),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-package-redirect-up',
              'foo',
              'bar',
              'package.json',
            ),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-package-redirect-up',
              'foo',
              'package.json',
            ),
          ],
        });
      });

      it('should determine sideEffects correctly (main field exists in downward package)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-package-redirect-down/foo/bar',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.resolve(
            rootDir,
            'node_modules/side-effects-package-redirect-down/foo/bar/baz/real-bar.js',
          ),
          sideEffects: false,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/side-effects-package-redirect-down',
              aboveFilePath: rootDir,
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.js',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.jsx',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.json',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.ts',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.tsx',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.cjs',
              ),
            },
            {
              filePath: path.join(
                rootDir,
                'node_modules',
                'side-effects-package-redirect-down',
                'foo',
                'bar.mjs',
              ),
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-package-redirect-down',
              'package.json',
            ),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-package-redirect-down',
              'foo',
              'bar',
              'package.json',
            ),
            path.join(
              rootDir,
              'node_modules',
              'side-effects-package-redirect-down',
              'foo',
              'bar',
              'baz',
              'package.json',
            ),
          ],
        });
      });
    });

    describe('sideEffects: globs', function () {
      it('should determine sideEffects correctly (matched)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false-glob/a/index',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(
          {filePath: resolved?.filePath, sideEffects: resolved?.sideEffects},
          {
            filePath: path.resolve(
              rootDir,
              'node_modules/side-effects-false-glob/a/index.js',
            ),
            sideEffects: undefined,
          },
        );
      });
      it('should determine sideEffects correctly (unmatched)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false-glob/b/index.js',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(
          {filePath: resolved?.filePath, sideEffects: resolved?.sideEffects},
          {
            filePath: path.resolve(
              rootDir,
              'node_modules/side-effects-false-glob/b/index.js',
            ),
            sideEffects: false,
          },
        );
      });
      it('should determine sideEffects correctly (matched dotslash)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false-glob/sub/index.js',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(
          {filePath: resolved?.filePath, sideEffects: resolved?.sideEffects},
          {
            filePath: path.resolve(
              rootDir,
              'node_modules/side-effects-false-glob/sub/index.js',
            ),
            sideEffects: undefined,
          },
        );
      });
      it('should determine sideEffects correctly (unmatched, prefix in subdir)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false-glob/sub/a/index.js',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(
          {filePath: resolved?.filePath, sideEffects: resolved?.sideEffects},
          {
            filePath: path.resolve(
              rootDir,
              'node_modules/side-effects-false-glob/sub/a/index.js',
            ),
            sideEffects: false,
          },
        );
      });
      it('should determine sideEffects correctly (only name)', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'side-effects-false-glob/sub/index.json',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(
          {filePath: resolved?.filePath, sideEffects: resolved?.sideEffects},
          {
            filePath: path.resolve(
              rootDir,
              'node_modules/side-effects-false-glob/sub/index.json',
            ),
            sideEffects: undefined,
          },
        );
      });
    });

    it('should not resolve a node module for URL dependencies', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '@scope/pkg',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(nullthrows(resolved).diagnostics, [
        {message: "Cannot load file './@scope/pkg' in './'.", hints: []},
      ]);
    });

    it('should resolve a node module for URL dependencies with the npm: prefix', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'npm:@scope/pkg',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'node_modules', '@scope', 'pkg', 'index.js'),
      );
    });

    it('should support query params for bare ESM specifiers', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '@scope/pkg?foo=2',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.resolve(rootDir, 'node_modules/@scope/pkg/index.js'),
      );
      assert.deepEqual(nullthrows(resolved).query?.toString(), 'foo=2');
    });

    it('should not support query params for bare CommonJS specifiers', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '@scope/pkg?foo=2',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(nullthrows(resolved).diagnostics, [
        {
          message: `Cannot find module '@scope/pkg?foo=2'`,
          hints: ["Did you mean '__@scope/pkg__'?"],
        },
      ]);
    });

    it('should support query params for npm: specifiers', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'npm:@scope/pkg?foo=2',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.resolve(rootDir, 'node_modules/@scope/pkg/index.js'),
      );
      assert.deepEqual(nullthrows(resolved).query?.toString(), 'foo=2');
    });
  });

  describe('aliases', function () {
    it('should alias the main file using the package.browser field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-browser-alias',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'browser.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-browser-alias',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-browser-alias',
            'package.json',
          ),
        ],
      });
    });

    it('should alias a sub-file using the package.browser field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-browser-alias/foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'bar.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-browser-alias',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-browser-alias',
            'package.json',
          ),
        ],
      });
    });

    it('should alias a relative file using the package.browser field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './foo',
        specifierType: 'esm',
        parent: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'browser.js',
        ),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'bar.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-browser-alias',
            'package.json',
          ),
        ],
      });
    });

    it('should not alias using the package.browser field with --target=node', async function () {
      let resolved = await resolver.resolve({
        env: NODE_INCLUDE_ENV,
        filename: 'package-browser-alias/foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'foo.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-browser-alias',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-browser-alias',
            'package.json',
          ),
        ],
      });
    });

    it('should alias a deep nested relative file using the package.browser field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './nested',
        specifierType: 'esm',
        parent: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'browser.js',
        ),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-browser-alias',
          'subfolder1/subfolder2/subfile.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(
              rootDir,
              'node_modules',
              'package-browser-alias',
              'subfolder1',
              'subfolder2',
            ),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-browser-alias',
            'package.json',
          ),
        ],
      });
    });

    it('should alias a sub-file using the package.alias field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-alias/foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'package-alias', 'bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-alias',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(rootDir, 'node_modules', 'package-alias', 'package.json'),
        ],
      });
    });

    it('should alias a relative file using the package.alias field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './foo',
        specifierType: 'esm',
        parent: path.join(
          rootDir,
          'node_modules',
          'package-alias',
          'browser.js',
        ),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'package-alias', 'bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'node_modules', 'package-alias', 'package.json'),
        ],
      });
    });

    it('should alias a glob using the package.alias field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './lib/test',
        specifierType: 'esm',
        parent: path.join(
          rootDir,
          'node_modules',
          'package-alias-glob',
          'index.js',
        ),
      });
      check(resolved, {
        filePath: path.join(
          rootDir,
          'node_modules',
          'package-alias-glob',
          'src',
          'test.js',
        ),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(
              rootDir,
              'node_modules',
              'package-alias-glob',
              'lib',
            ),
          },
          {
            fileName: 'package.json',
            aboveFilePath: path.join(
              rootDir,
              'node_modules',
              'package-alias-glob',
              'src',
            ),
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-alias-glob',
            'package.json',
          ),
        ],
      });
    });

    it('should apply a module alias using the package.alias field in the root package', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliased',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'foo', 'index.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/foo',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'node_modules', 'foo', 'package.json'),
        ],
      });
    });

    it('should apply a global module alias using the package.alias field in the root package', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliased',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'package-alias', 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'foo', 'index.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/foo',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'node_modules', 'foo', 'package.json'),
        ],
      });
    });

    it('should apply a global module alias to a sub-file in a package', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliased/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'package-alias', 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'node_modules', 'foo', 'bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/foo',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'node_modules', 'foo', 'package.json'),
        ],
      });
    });

    it('should apply a module alias pointing to a file using the package.alias field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliased-file',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply a global module alias pointing to a file using the package.alias field', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliased-file',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'package-alias', 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module folder (relative to project dir)', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliasedfolder/test.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'test.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module folder only (relative to project dir)', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliasedfolder',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'index.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
          {
            filePath: path.join(rootDir, 'nested'),
          },
          {
            filePath: path.join(rootDir, 'nested.js'),
          },
          {
            filePath: path.join(rootDir, 'nested.jsx'),
          },
          {
            filePath: path.join(rootDir, 'nested.cjs'),
          },
          {
            filePath: path.join(rootDir, 'nested.mjs'),
          },
          {
            filePath: path.join(rootDir, 'nested.ts'),
          },
          {
            filePath: path.join(rootDir, 'nested.tsx'),
          },
          {
            filePath: path.join(rootDir, 'nested', 'package.json'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module folder (relative to root dir)', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliasedabsolute/test.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'test.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module folder only (relative to root dir)', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'aliasedabsolute',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'index.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
          {
            filePath: path.join(rootDir, 'nested'),
          },
          {
            filePath: path.join(rootDir, 'nested.js'),
          },
          {
            filePath: path.join(rootDir, 'nested.jsx'),
          },
          {
            filePath: path.join(rootDir, 'nested.cjs'),
          },
          {
            filePath: path.join(rootDir, 'nested.mjs'),
          },
          {
            filePath: path.join(rootDir, 'nested.ts'),
          },
          {
            filePath: path.join(rootDir, 'nested.tsx'),
          },
          {
            filePath: path.join(rootDir, 'nested', 'package.json'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module folder sub-path', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'foo/bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'bar.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module folder glob sub-path', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'glob/bar/test',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'test.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply an alias for a virtual module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'something',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'test.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should apply a global alias for a virtual module', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'something',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'package-alias', 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(rootDir, 'nested', 'test.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'package.json',
            aboveFilePath: path.join(rootDir, 'nested'),
          },
        ],
        invalidateOnFileChange: [path.join(rootDir, 'package.json')],
      });
    });

    it('should resolve to an empty file when package.browser resolves to false', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-browser-exclude',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(__dirname, '..', 'src', '_empty.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-browser-exclude',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-browser-exclude',
            'package.json',
          ),
        ],
      });
    });

    it('should resolve to an empty file when package.alias resolves to false', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-alias-exclude',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {
        filePath: path.join(__dirname, '..', 'src', '_empty.js'),
        sideEffects: undefined,
        query: undefined,
        invalidateOnFileCreate: [
          {
            fileName: 'node_modules/package-alias-exclude',
            aboveFilePath: rootDir,
          },
        ],
        invalidateOnFileChange: [
          path.join(rootDir, 'package.json'),
          path.join(rootDir, 'tsconfig.json'),
          path.join(
            rootDir,
            'node_modules',
            'package-alias-exclude',
            'package.json',
          ),
        ],
      });
    });
  });

  describe('source field', function () {
    describe('package behind symlinks', function () {
      it('should use the source field, when its realpath is not under `node_modules`', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'source',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.join(rootDir, 'packages', 'source', 'source.js'),
          sideEffects: undefined,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/source',
              aboveFilePath: rootDir,
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(rootDir, 'node_modules', 'source', 'package.json'),
            path.join(rootDir, 'packages', 'source', 'package.json'),
          ],
        });
      });

      it('should prioritize the source field over exports', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'source-exports',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.join(
            rootDir,
            'packages',
            'source-exports',
            'source.js',
          ),
          sideEffects: undefined,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/source-exports',
              aboveFilePath: rootDir,
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'source-exports',
              'package.json',
            ),
            path.join(rootDir, 'packages', 'source-exports', 'package.json'),
          ],
        });
      });

      it('should not use the source field, when its realpath is under `node_modules`', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'source-pnpm',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.join(
            rootDir,
            'node_modules',
            '.pnpm',
            'source-pnpm@1.0.0',
            'node_modules',
            'source-pnpm',
            'dist.js',
          ),
          sideEffects: undefined,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/source-pnpm',
              aboveFilePath: rootDir,
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(rootDir, 'node_modules', 'source-pnpm', 'package.json'),
            path.join(
              rootDir,
              'node_modules',
              '.pnpm',
              'source-pnpm@1.0.0',
              'node_modules',
              'source-pnpm',
              'package.json',
            ),
          ],
        });
      });
    });

    describe('package not behind symlinks', function () {
      it('should not use the source field', async function () {
        let resolved = await resolver.resolve({
          env: BROWSER_ENV,
          filename: 'source-not-symlinked',
          specifierType: 'esm',
          parent: path.join(rootDir, 'foo.js'),
        });
        check(resolved, {
          filePath: path.join(
            rootDir,
            'node_modules',
            'source-not-symlinked',
            'dist.js',
          ),
          sideEffects: undefined,
          query: undefined,
          invalidateOnFileCreate: [
            {
              fileName: 'node_modules/source-not-symlinked',
              aboveFilePath: rootDir,
            },
          ],
          invalidateOnFileChange: [
            path.join(rootDir, 'package.json'),
            path.join(rootDir, 'tsconfig.json'),
            path.join(
              rootDir,
              'node_modules',
              'source-not-symlinked',
              'package.json',
            ),
          ],
        });
      });
    });
  });

  describe('package exports', function () {
    it('should resolve a browser development import', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-conditions',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        resolved?.filePath,
        path.join(
          rootDir,
          'node_modules/package-conditions/browser-import-dev.mjs',
        ),
      );
    });

    it('should resolve a browser development require', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-conditions',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        resolved?.filePath,
        path.join(
          rootDir,
          'node_modules/package-conditions/browser-require-dev.cjs',
        ),
      );
    });

    it('should resolve a browser production import', async function () {
      let resolved = await prodResolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-conditions',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        resolved?.filePath,
        path.join(
          rootDir,
          'node_modules/package-conditions/browser-import-prod.mjs',
        ),
      );
    });

    it('should resolve a browser development require', async function () {
      let resolved = await prodResolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-conditions',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        resolved?.filePath,
        path.join(
          rootDir,
          'node_modules/package-conditions/browser-require-prod.cjs',
        ),
      );
    });

    it('should resolve a node import', async function () {
      let resolved = await resolver.resolve({
        env: NODE_INCLUDE_ENV,
        filename: 'package-conditions',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        resolved?.filePath,
        path.join(rootDir, 'node_modules/package-conditions/node-import.mjs'),
      );
    });

    it('should resolve a node require', async function () {
      let resolved = await resolver.resolve({
        env: NODE_INCLUDE_ENV,
        filename: 'package-conditions',
        specifierType: 'commonjs',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        resolved?.filePath,
        path.join(rootDir, 'node_modules/package-conditions/node-require.cjs'),
      );
    });
  });

  describe('symlinks', function () {
    it('should resolve symlinked files to their realpath', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './baz.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });

    it('should resolve symlinked directories to their realpath', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './symlinked-nested',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'nested', 'index.js'),
      );
    });
  });

  describe('error handling', function () {
    it('should return diagnostics when package.module does not exist', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-module-fallback',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });

      assert.equal(
        nullthrows(nullthrows(result).diagnostics)[0].message,
        `Could not load './module.js' from module 'package-module-fallback' found in package.json#module`,
      );
    });

    it('should throw when a relative path cannot be resolved', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './xyz.js',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });

      assert.equal(
        nullthrows(nullthrows(result).diagnostics)[0].message,
        `Cannot load file './xyz.js' in './'.`,
      );
    });

    it('should throw when a node_module cannot be resolved', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'food',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });

      assert.deepEqual(nullthrows(nullthrows(result).diagnostics)[0], {
        message: `Cannot find module 'food'`,
        hints: [`Did you mean '__foo__'?`],
      });
    });

    it('should throw when a subfile of a node_module cannot be resolved', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'foo/bark',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });

      assert.deepEqual(nullthrows(nullthrows(result).diagnostics)[0], {
        message: `Cannot load file './bark' from module 'foo'`,
        hints: [`Did you mean '__foo/bar__'?`],
      });
    });

    it('should error when a library is missing an external dependency', async function () {
      let result = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'browser',
            isLibrary: true,
            includeNodeModules: false,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'test',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
        sourcePath: path.join(rootDir, 'foo.js'),
      });

      assert.equal(
        result?.diagnostics?.[0].message,
        'External dependency "test" is not declared in package.json.',
      );
    });

    it('should not error when external dependencies are declared', async function () {
      let result = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'browser',
            isLibrary: true,
            includeNodeModules: false,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
        sourcePath: path.join(rootDir, 'foo.js'),
      });

      assert.deepEqual(result, {
        isExcluded: true,
        invalidateOnFileChange: [],
        invalidateOnFileCreate: [],
      });
    });

    it('should not error when external dependencies are declared in peerDependencies', async function () {
      let result = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'browser',
            isLibrary: true,
            includeNodeModules: false,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
        sourcePath: path.join(rootDir, 'foo.js'),
      });

      assert.deepEqual(result, {
        isExcluded: true,
        invalidateOnFileChange: [],
        invalidateOnFileCreate: [],
      });
    });

    it('should not error on missing dependencies for environment builtins', async function () {
      let result = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'browser',
            isLibrary: true,
            includeNodeModules: false,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'atom',
        specifierType: 'esm',
        parent: path.join(rootDir, 'env-dep/foo.js'),
        sourcePath: path.join(rootDir, 'env-dep/foo.js'),
      });

      assert.deepEqual(result, {
        isExcluded: true,
        invalidateOnFileChange: [],
        invalidateOnFileCreate: [],
      });
    });

    it('should not error on builtin node modules', async function () {
      let result = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'browser',
            isLibrary: true,
            includeNodeModules: false,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'buffer',
        specifierType: 'esm',
        parent: path.join(rootDir, 'env-dep/foo.js'),
        sourcePath: path.join(rootDir, 'env-dep/foo.js'),
      });

      assert.deepEqual(result, {isExcluded: true});
    });

    it('should error when a library has an incorrect external dependency version', async function () {
      let result = await resolver.resolve({
        env: new Environment(
          createEnvironment({
            context: 'browser',
            isLibrary: true,
            includeNodeModules: false,
          }),
          DEFAULT_OPTIONS,
        ),
        filename: 'foo',
        specifierType: 'esm',
        range: '^0.4.0',
        parent: path.join(rootDir, 'foo.js'),
        sourcePath: path.join(rootDir, 'foo.js'),
      });

      assert.equal(
        result?.diagnostics?.[0].message,
        'External dependency "foo" does not satisfy required semver range "^0.4.0".',
      );
    });

    it('should error when package.json is invalid', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'json-error',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      let file = path.join(
        rootDir,
        'node_modules',
        'json-error',
        'package.json',
      );
      assert.deepEqual(result?.diagnostics, [
        {
          message: 'Error parsing JSON',
          codeFrames: [
            {
              language: 'json',
              filePath: file,
              code: await overlayFS.readFile(file, 'utf8'),
              codeHighlights: [
                {
                  message: 'expected `,` or `}` at line 3 column 3',
                  start: {
                    line: 3,
                    column: 3,
                  },
                  end: {
                    line: 3,
                    column: 3,
                  },
                },
              ],
            },
          ],
        },
      ]);
    });

    it('should error on an invalid empty specifier', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(result?.diagnostics, [
        {
          message: 'Invalid empty specifier',
        },
      ]);
    });

    it('should error on unknown URL schemes', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'http://parceljs.org',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
        loc: {
          filePath: path.join(rootDir, 'foo.js'),
          start: {
            line: 1,
            column: 1,
          },
          end: {
            line: 1,
            column: 10,
          },
        },
      });
      assert.deepEqual(result?.diagnostics, [
        {
          message: `Unknown url scheme or pipeline 'http:'`,
        },
      ]);
    });

    it('should error on non-exported package paths', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-exports/internal',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      let file = path.join(
        rootDir,
        'node_modules/package-exports/package.json',
      );
      assert.deepEqual(result?.diagnostics, [
        {
          message: `Module 'package-exports/internal' is not exported from the 'package-exports' package`,
          codeFrames: [
            {
              language: 'json',
              filePath: file,
              code: await overlayFS.readFile(file, 'utf8'),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 4,
                    column: 14,
                  },
                  end: {
                    line: 13,
                    column: 3,
                  },
                },
              ],
            },
          ],
        },
      ]);
    });

    it('should error when export does not exist', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-exports/missing',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.deepEqual(result?.diagnostics, [
        {
          message: `Cannot load file './missing.mjs' from module 'package-exports'`,
          hints: [],
        },
      ]);
    });

    it('should error on undefined package imports', async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '#foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.js'),
      });
      let file = path.join(rootDir, 'package.json');
      assert.deepEqual(result?.diagnostics, [
        {
          message: `Package import '#foo' is not defined in the 'resolver' package`,
          codeFrames: [
            {
              language: 'json',
              filePath: file,
              code: await overlayFS.readFile(file, 'utf8'),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 15,
                    column: 14,
                  },
                  end: {
                    line: 17,
                    column: 3,
                  },
                },
              ],
            },
          ],
        },
      ]);
    });

    it("should error when package.json doesn't define imports field", async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '#foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'node_modules', 'foo', 'foo.js'),
      });
      let file = path.join(rootDir, 'node_modules', 'foo', 'package.json');
      assert.deepEqual(result?.diagnostics, [
        {
          message: `Package import '#foo' is not defined in the 'foo' package`,
          codeFrames: [
            {
              language: 'json',
              filePath: file,
              code: await overlayFS.readFile(file, 'utf8'),
              codeHighlights: [],
            },
          ],
        },
      ]);
    });

    it("should error when a package.json couldn't be found", async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '#foo',
        specifierType: 'esm',
        parent: path.join(
          rootDir,
          'node_modules',
          'tsconfig-not-used',
          'foo.js',
        ),
      });
      assert.deepEqual(result?.diagnostics, [
        {
          message: `Cannot find a package.json above './node\\_modules/tsconfig-not-used'`,
        },
      ]);
    });

    it("should error when a tsconfig.json extends couldn't be found", async function () {
      let result = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'tsconfig', 'extends-not-found', 'index.js'),
      });
      let file = path.join(
        rootDir,
        'tsconfig',
        'extends-not-found',
        'tsconfig.json',
      );
      assert.deepEqual(result?.diagnostics, [
        {
          message: 'Could not find extended tsconfig',
          codeFrames: [
            {
              language: 'json',
              filePath: file,
              code: await overlayFS.readFile(file, 'utf8'),
              codeHighlights: [
                {
                  message: undefined,
                  start: {
                    line: 2,
                    column: 14,
                  },
                  end: {
                    line: 2,
                    column: 26,
                  },
                },
              ],
            },
          ],
        },
        {
          message:
            "Cannot load file './not-found' in './tsconfig/extends-not-found'.",
          hints: [],
        },
      ]);
    });
  });

  describe('urls', function () {
    it('should ignore protocol relative urls', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '//example.com/foo.png',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {isExcluded: true});
    });

    it('should ignore hash urls', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: '#hash',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {isExcluded: true});
    });

    it('should ignore http: urls', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'http://example.com/foo.png',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      check(resolved, {isExcluded: true});
    });

    it('should treat file: urls as absolute paths', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'file:///bar.js',
        specifierType: 'url',
        parent: path.join(rootDir, 'foo.js'),
      });
      assert.equal(nullthrows(resolved).filePath, path.join(rootDir, 'bar.js'));
    });
  });

  describe('options', function () {
    it('supports custom extensions', async function () {
      let resolver = new NodeResolver({
        fs: overlayFS,
        projectRoot: rootDir,
        mode: 'development',
        extensions: ['html'],
      });

      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './bar',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.ts'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'bar.html'),
      );

      resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: './foo',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.ts'),
      });
      assert.equal(nullthrows(resolved).filePath, null);
    });

    it('supports custom mainFields', async function () {
      let resolved = await resolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-types',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.ts'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'node_modules', 'package-types', 'main.js'),
      );

      let typesResolver = new NodeResolver({
        fs: overlayFS,
        projectRoot: rootDir,
        mode: 'development',
        mainFields: ['types', 'main'],
      });

      resolved = await typesResolver.resolve({
        env: BROWSER_ENV,
        filename: 'package-types',
        specifierType: 'esm',
        parent: path.join(rootDir, 'foo.ts'),
      });
      assert.equal(
        nullthrows(resolved).filePath,
        path.join(rootDir, 'node_modules', 'package-types', 'types.d.ts'),
      );
    });
  });
});
