// @flow strict-local
import path from 'path';
import assert from 'assert';
import {
  assertBundles,
  bundle,
  distDir,
  fsFixture,
  outputFS,
  overlayFS,
} from '@parcel/test-utils';

import {PARCEL_VERSION} from '../../core/src/constants';

describe('JS API', function () {
  it('should respect distEntry', async function () {
    const NAME = 'custom-name.js';

    let b = await bundle(
      path.join(__dirname, '/integration/js-comment/index.js'),
      {
        targets: {
          default: {distDir, distEntry: NAME},
        },
      },
    );

    assertBundles(b, [
      {
        name: NAME,
        type: 'js',
        assets: ['index.js'],
      },
    ]);

    assert(await outputFS.exists(path.join(distDir, NAME)));
  });

  it('should run additional reports from the options', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/js-comment/index.js'),
      {
        additionalReporters: [
          {
            packageName: '@parcel/reporter-bundle-buddy',
            resolveFrom: __dirname,
          },
        ],
      },
    );

    assertBundles(b, [
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);

    assert(await outputFS.exists(path.join(distDir, 'bundle-buddy.json')));
  });

  describe('Reporter API', () => {
    it('should pass the parcel version to plugins', async () => {
      const dir = path.join(__dirname, 'plugin-parcel-version');

      overlayFS.mkdirp(dir);

      await fsFixture(overlayFS, dir)`
      index.js:
        export default 'Hi';

      .parcelrc:
        {
          extends: "@parcel/config-default",
          reporters: ["./reporter-plugin.js", "..."],
        }

      package.json:
        {
          "version": "1234"
        }

      yarn.lock:

      reporter-plugin.js:
        import {Reporter} from '@parcel/plugin';
        import path from 'node:path';

        export default new Reporter({
          async report({event, options}) {
            if (event.type === 'buildSuccess') {
              await options.outputFS.writeFile(path.join(options.projectRoot, 'parcel-version.txt'), options.parcelVersion);
            }
          }
        })
      `;

      await bundle(path.join(dir, 'index.js'), {
        inputFS: overlayFS,
        outputFS: overlayFS,
      });

      assert.equal(
        await overlayFS.readFile(path.join(dir, 'parcel-version.txt')),
        PARCEL_VERSION,
      );
    });
  });
});
