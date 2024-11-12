// @flow strict-local

import type {ProgramOptions} from '@parcel/link';

import {createProgram as _createProgram} from '@parcel/link';
import {fsFixture, overlayFS} from '@parcel/test-utils';

import assert from 'assert';
import path from 'path';
import sinon from 'sinon';

function createProgram(opts: ProgramOptions) {
  let program = _createProgram(opts).exitOverride();

  function cli(command: string = ''): Promise<void> {
    return program.parseAsync(command.split(/\s+/), {from: 'user'});
  }

  return cli;
}

describe('@parcel/link', () => {
  let _cwd;
  let _stdout;

  beforeEach(async function () {
    await overlayFS.mkdirp('/app');
    overlayFS.chdir('/app');

    // $FlowFixMe[incompatible-call]
    _cwd = sinon.stub(process, 'cwd').callsFake(() => overlayFS.cwd());
    _stdout = sinon.stub(process.stdout, 'write');
  });

  afterEach(function () {
    _cwd?.restore();
    _stdout?.restore();
    _cwd = null;
    _stdout = null;
  });

  it('prints help text', async () => {
    let cli = createProgram({fs: overlayFS});
    // $FlowFixMe[prop-missing]
    await assert.rejects(() => cli('--help'), /\(outputHelp\)/);
  });

  it('links by default', async () => {
    let link = sinon.stub();
    let cli = createProgram({fs: overlayFS, link});
    await cli();
    assert(link.called);
  });

  describe('link', () => {
    it('errors for invalid app root', async () => {
      let cli = createProgram({fs: overlayFS});

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => cli('link'), /Not a project root/);
    });

    it('errors for invalid package root', async () => {
      await fsFixture(overlayFS)`yarn.lock:`;

      assert(overlayFS.existsSync('/app/yarn.lock'));

      let cli = createProgram({fs: overlayFS});

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => cli('link /fake'), /Not a package root/);
    });

    it('errors when a link exists', async () => {
      await fsFixture(overlayFS)`yarn.lock:`;

      let cli = createProgram({fs: overlayFS});
      await cli(`link`);

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => cli('link'), /link already exists/);
    });

    it('links with the default options', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        node_modules
          parcel
          @parcel/core`;

      let cli = createProgram({fs: overlayFS});
      await cli('link');

      assert(overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.realpathSync('node_modules/@parcel/core'),
        path.resolve(__dirname, '../../core'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/parcel'),
        path.resolve(__dirname, '../../parcel'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/.bin/parcel'),
        path.resolve(__dirname, '../../parcel/src/bin.js'),
      );
    });

    it('links from a custom package root', async () => {
      await fsFixture(overlayFS, '/')`
        app
          yarn.lock:
          node_modules
            parcel
            @parcel/core
        package-root
          core
            core/package.json: ${{name: '@parcel/core'}}
            parcel
              package.json: ${{name: 'parcel'}}
              src/bin.js:`;

      overlayFS.chdir('/app');

      let cli = createProgram({fs: overlayFS});
      await cli(`link ../package-root`);

      assert(overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.realpathSync('node_modules/@parcel/core'),
        path.resolve(overlayFS.cwd(), '../package-root/core/core'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/parcel'),
        path.resolve(overlayFS.cwd(), '../package-root/core/parcel'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/.bin/parcel'),
        path.resolve(overlayFS.cwd(), '../package-root/core/parcel/src/bin.js'),
      );
    });

    it('links with a custom namespace', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        node_modules
          .bin/parcel:
          @namespace
            parcel
            parcel-core`;

      let cli = createProgram({fs: overlayFS});
      await cli('link --namespace @namespace');

      assert(overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.realpathSync('node_modules/.bin/parcel'),
        path.resolve(__dirname, '../../parcel/src/bin.js'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/@namespace/parcel-core'),
        path.resolve(__dirname, '../../core'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/@parcel/core'),
        path.resolve(__dirname, '../../core'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/@namespace/parcel'),
        path.resolve(__dirname, '../../parcel'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/parcel'),
        path.resolve(__dirname, '../../parcel'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/.bin/parcel'),
        path.resolve(__dirname, '../../parcel/src/bin.js'),
      );
    });

    // FIXME: this test fails on windows
    it.skip('updates config for custom namespace', async () => {
      await fsFixture(overlayFS, '/')`
        ${path.resolve(
          path.join(__dirname, '../../../configs/namespace/package.json'),
        )}: ${{
        name: '@parcel/config-namespace',
      }}
        app
          yarn.lock:
          .parcelrc: ${{
            extends: '@namespace/parcel-config-namespace',
            transformers: {
              '*': [
                '@namespace/parcel-transformer-js',
                '@namespace/parcel-transformer-local',
              ],
            },
          }}
          package.json: ${{
            ['@namespace/parcel-transformer-js']: {},
            ['@namespace/parcel-transformer-local']: {},
          }}`;

      overlayFS.chdir('/app');

      let cli = createProgram({fs: overlayFS});
      await cli('link --namespace @namespace');

      assert(overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.readFileSync('.parcelrc', 'utf8'),
        JSON.stringify({
          extends: '@parcel/config-namespace',
          transformers: {
            '*': [
              '@parcel/transformer-js',
              '@namespace/parcel-transformer-local',
            ],
          },
        }),
      );

      assert.equal(
        overlayFS.readFileSync('package.json', 'utf8'),
        JSON.stringify({
          ['@parcel/transformer-js']: {},
          ['@namespace/parcel-transformer-local']: {},
        }),
      );
    });

    it('links with custom node modules glob', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        tools
          test/node_modules/parcel
          test2/node_modules/@parcel/core`;

      let cli = createProgram({fs: overlayFS});
      await cli('link --node-modules-glob "tools/*/node_modules"');

      assert(overlayFS.existsSync('.parcel-link'));

      assert(overlayFS.existsSync('tools/test/node_modules'));
      assert(!overlayFS.existsSync('tools/test/node_modules/parcel'));

      assert(overlayFS.existsSync('tools/test2/node_modules'));
      assert(!overlayFS.existsSync('tools/test2/node_modules/@parcel/core'));

      assert.equal(
        overlayFS.realpathSync('node_modules/parcel'),
        path.resolve(__dirname, '../../parcel'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/.bin/parcel'),
        path.resolve(__dirname, '../../parcel/src/bin.js'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/@parcel/core'),
        path.resolve(__dirname, '../../core'),
      );
    });

    it('does not do anything with dry run', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        node_modules
          parcel
          @parcel/core`;

      let cli = createProgram({fs: overlayFS});
      await cli('link --dry-run');

      assert(!overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.realpathSync('node_modules/@parcel/core'),
        path.resolve('/app/node_modules/@parcel/core'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/parcel'),
        path.resolve('/app/node_modules/parcel'),
      );

      assert(!overlayFS.existsSync('node_modules/.bin/parcel'));
    });
  });

  describe('unlink', () => {
    it('errors without a link config', async () => {
      await fsFixture(overlayFS)`yarn.lock:`;

      let cli = createProgram({fs: overlayFS});

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => cli('unlink'), /link could not be found/);
    });

    it('errors for invalid app root', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        .parcel-link: ${{
          appRoot: '/app2',
          packageRoot: path.resolve(__dirname, '../../..'),
          nodeModulesGlobs: ['node_modules'],
          namespace: '@parcel',
        }}`;

      let cli = createProgram({fs: overlayFS});

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => cli('unlink'), /Not a project root/);
    });

    it('errors for invalid package root', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: path.resolve(__dirname, '../../..') + '2',
          nodeModulesGlobs: ['node_modules'],
          namespace: '@parcel',
        }}`;

      let cli = createProgram({fs: overlayFS});

      // $FlowFixMe[prop-missing]
      await assert.rejects(() => cli('unlink'), /Not a package root/);
    });

    it('unlinks with the default options', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        node_modules
          .bin/parcel -> ${path.resolve(__dirname, '../../parcel/src/bin.js')}
          parcel -> ${path.resolve(__dirname, '../../parcel')}
          @parcel/core -> ${path.resolve(__dirname, '../../core')}
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: path.resolve(__dirname, '../../..'),
          nodeModulesGlobs: ['node_modules'],
          namespace: '@parcel',
        }}`;

      assert(overlayFS.existsSync('.parcel-link'));
      assert(overlayFS.existsSync('node_modules/@parcel/core'));
      assert(overlayFS.existsSync('node_modules/parcel'));
      assert(overlayFS.existsSync('node_modules/.bin/parcel'));

      let cli = createProgram({fs: overlayFS});
      await cli('unlink');

      assert(!overlayFS.existsSync('.parcel-link'));
      assert(!overlayFS.existsSync('node_modules/@parcel/core'));
      assert(!overlayFS.existsSync('node_modules/parcel'));
      assert(!overlayFS.existsSync('node_modules/.bin/parcel'));
    });

    it('unlinks from a custom package root', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: '/package-root',
          nodeModulesGlobs: ['node_modules'],
          namespace: '@parcel',
        }}
        node_modules/parcel -> package-root/core/parcel
        node_modules/@parcel/core -> package-root/core/core
        node_modules/.bin/parcel -> package-root/core/parcel/src/bin.js`;

      await fsFixture(overlayFS, '/')`
        package-root/core/core/package.json: ${{name: '@parcel/core'}}
        package-root/core/parcel/package.json: ${{name: 'parcel'}}
        package-root/core/parcel/src/bin.js:`;

      let cli = createProgram({fs: overlayFS});
      await cli('unlink');

      assert(!overlayFS.existsSync('.parcel-link'));
      assert(!overlayFS.existsSync('node_modules/@parcel/core'));
      assert(!overlayFS.existsSync('node_modules/parcel'));
      assert(!overlayFS.existsSync('node_modules/.bin/parcel'));
    });

    it('unlinks with a custom namespace', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: path.resolve(__dirname, '../../..'),
          nodeModulesGlobs: ['node_modules'],
          namespace: '@namespace',
        }}
        node_modules
          .bin/parcel -> ${path.resolve(__dirname, '../../parcel/src/bin.js')}
          parcel -> ${path.resolve(__dirname, '../../parcel')}
          @namespace/parcel -> ${path.resolve(__dirname, '../../parcel')}
          parcel/core -> ${path.resolve(__dirname, '../../core')}
          @namespace/parcel-core -> ${path.resolve(__dirname, '../../core')}`;

      let cli = createProgram({fs: overlayFS});
      await cli('unlink');

      assert(!overlayFS.existsSync('.parcel-link'));
      assert(!overlayFS.existsSync('node_modules/@parcel/core'));
      assert(!overlayFS.existsSync('node_modules/parcel'));
      assert(!overlayFS.existsSync('node_modules/.bin/parcel'));
      assert(!overlayFS.existsSync('node_modules/@namespace/parcel-core'));
      assert(!overlayFS.existsSync('node_modules/@namespace/parcel'));
    });

    // FIXME: this test fails on windows
    it.skip('updates config for custom namespace', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        .parcelrc: ${{
          extends: '@parcel/config-namespace',
          transformers: {
            '*': [
              '@parcel/transformer-js',
              '@namespace/parcel-transformer-local',
            ],
          },
        }}
        package.json: ${{
          ['@parcel/transformer-js']: {},
          ['@namespace/parcel-transformer-local']: {},
        }}
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: path.resolve(__dirname, '../../..'),
          nodeModulesGlobs: ['node_modules'],
          namespace: '@namespace',
        }}`;

      await fsFixture(overlayFS, '/')`
        ${path.resolve(
          path.join(__dirname, '../../../configs/namespace/package.json'),
        )}: ${{
        name: '@parcel/config-namespace',
      }}`;

      let cli = createProgram({fs: overlayFS});
      await cli('unlink');

      assert(!overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.readFileSync('.parcelrc', 'utf8'),
        JSON.stringify({
          extends: '@namespace/parcel-config-namespace',
          transformers: {
            '*': [
              '@namespace/parcel-transformer-js',
              '@namespace/parcel-transformer-local',
            ],
          },
        }),
      );

      assert.equal(
        overlayFS.readFileSync('package.json', 'utf8'),
        JSON.stringify({
          ['@namespace/parcel-transformer-js']: {},
          ['@namespace/parcel-transformer-local']: {},
        }),
      );
    });

    it('unlinks with custom node modules glob', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: path.resolve(__dirname, '../../..'),
          nodeModulesGlobs: ['node_modules', 'tools/*/node_modules'],
          namespace: '@parcel',
        }}
        node_modules
          parcel -> ${path.resolve(__dirname, '../../parcel')}
          @parcel/core -> ${path.resolve(__dirname, '../../core')}
          .bin/parcel -> ${path.resolve(__dirname, '../../parcel/src/bin.js')}
        tools
          test/node_modules/parcel -> ${path.resolve(__dirname, '../../parcel')}
          test2/node_modules/@parcel/core -> ${path.resolve(
            __dirname,
            '../../core',
          )}`;

      let cli = createProgram({fs: overlayFS});
      await cli('unlink');

      assert(!overlayFS.existsSync('.parcel-link'));
      assert(!overlayFS.existsSync('node_modules/@parcel/core'));
      assert(!overlayFS.existsSync('node_modules/parcel'));
      assert(!overlayFS.existsSync('node_modules/.bin/parcel'));
      assert(!overlayFS.existsSync('tools/test/node_modules/parcel'));
      assert(!overlayFS.existsSync('tools/test2/node_modules/@parcel/core'));
    });

    it('does not do anything with dry run', async () => {
      await fsFixture(overlayFS)`
        yarn.lock:
        node_modules
          .bin/parcel -> ${path.resolve(__dirname, '../../parcel/src/bin.js')}
          parcel -> ${path.resolve(__dirname, '../../parcel')}
          @parcel/core -> ${path.resolve(__dirname, '../../core')}
        .parcel-link: ${{
          appRoot: '/app',
          packageRoot: path.resolve(__dirname, '../../..'),
          nodeModulesGlobs: ['node_modules'],
          namespace: '@parcel',
        }}
      `;

      let cli = createProgram({fs: overlayFS});
      await cli('unlink --dry-run');

      assert(overlayFS.existsSync('.parcel-link'));

      assert.equal(
        overlayFS.realpathSync('node_modules/@parcel/core'),
        path.resolve(__dirname, '../../core'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/parcel'),
        path.resolve(__dirname, '../../parcel'),
      );

      assert.equal(
        overlayFS.realpathSync('node_modules/.bin/parcel'),
        path.resolve(__dirname, '../../parcel/src/bin.js'),
      );
    });
  });
});
