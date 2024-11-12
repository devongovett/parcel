import assert from 'assert';
import Module from 'module';
import path from 'path';
import {bundle, run, assertBundles} from '@parcel/test-utils';

describe('pnp', function () {
  it('should defer to the pnp resolution when needed', async function () {
    let dir = path.join(__dirname, 'integration/pnp-require');

    let origPnpVersion = process.versions.pnp;
    process.versions.pnp = 42;

    let origModuleResolveFilename = Module._resolveFilename;
    Module.findPnpApi = () => require(path.join(dir, '.pnp.js'));
    Module._resolveFilename = (name, ...args) =>
      name === 'pnpapi'
        ? path.join(dir, '.pnp.js')
        : origModuleResolveFilename(name, ...args);

    try {
      let b = await bundle(path.join(dir, 'index.js'));

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'local.js', 'index.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(output(), 3);
    } finally {
      process.versions.pnp = origPnpVersion;
      Module._resolveFilename = origModuleResolveFilename;
    }
  });

  it('should support importing Node builtin modules from npm when requested', async function () {
    let dir = path.join(__dirname, 'integration/pnp-builtin');

    let origPnpVersion = process.versions.pnp;
    process.versions.pnp = 42;

    let origModuleResolveFilename = Module._resolveFilename;
    Module.findPnpApi = () => require(path.join(dir, '.pnp.js'));
    Module._resolveFilename = (name, ...args) =>
      name === 'pnpapi'
        ? path.join(dir, '.pnp.js')
        : origModuleResolveFilename(name, ...args);

    try {
      let b = await bundle(path.join(dir, 'index.js'));

      assertBundles(b, [
        {
          name: 'index.js',
          assets: ['index.js', 'local.js', 'index.js'],
        },
      ]);

      let output = await run(b);
      assert.equal(output(), 3);
    } finally {
      process.versions.pnp = origPnpVersion;
      Module._resolveFilename = origModuleResolveFilename;
    }
  });
});
