// @flow strict-local
import assert from 'assert';
import path from 'path';
import {bundle, run, overlayFS, fsFixture} from '@parcel/test-utils';

describe('plugins with "registered" languages', () => {
  it('should support plugins with esbuild-register', async () => {
    const dir = path.join(__dirname, 'esbuild-register-plugin');
    overlayFS.mkdirp(dir);

    await fsFixture(overlayFS, dir)`
      package.json:
        {
          "name": "app",
          "sideEffects": true
        }

      yarn.lock:

      index.js:
        console.log("Hi, mum!");

      .parcelrc:
        {
          extends: "@parcel/config-default",
          reporters: ["...", "./reporter-plugin.js"],
        }

      reporter-plugin.js:
        require('esbuild-register/dist/node').register();
        const plugin = require('./reporter-plugin.ts');
        module.exports = plugin;

      reporter-plugin.ts:
        import fs from 'fs';
        import { Reporter } from '@parcel/plugin';
        import { someString } from './some-string';
        export default new Reporter({
            async report({ event, options }) {
                if (event.type === 'buildStart') {
                    await options.outputFS.writeFile(options.projectRoot + '/output.txt', 'Hello! ' + someString, 'utf8');
                }
            }
        });

      some-string.ts:
        export const someString = 'something';
        `;

    const b = await bundle(path.join(dir, 'index.js'), {
      inputFS: overlayFS,
      outputFS: overlayFS,
      additionalReporters: [
        {packageName: '@parcel/reporter-json', resolveFrom: __filename},
      ],
    });

    await run(b);

    // Tests that the plugin actually loaded properly by validating that it output
    // what it was supposed to output. If `esbuild-register` isn't used, or the resolver
    // doesn't support updating extensions as they change, then the plugin won't work.
    assert(overlayFS.existsSync(path.join(dir, 'output.txt')));
    assert.equal(
      overlayFS.readFileSync(path.join(dir, 'output.txt'), 'utf8'),
      'Hello! something',
    );
  });
});
