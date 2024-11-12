import assert from 'assert';
import path from 'node:path';
import {rimraf} from 'rimraf';
import {bundle, run, overlayFS, fsFixture} from '@parcel/test-utils';

describe('feature flags', () => {
  let dir = path.join(__dirname, 'feature-flags-fixture');
  beforeEach(async () => {
    await rimraf(dir);
    await overlayFS.mkdirp(dir);
    await fsFixture(overlayFS, dir)`
    yarn.lock:
        // required for .parcelrc to work

    package.json:
        {
            "name": "feature-flags-fixture",
            "version": "1.0.0"
        }

    index.js:
        module.exports = "MARKER";

    .parcelrc:
        {
            extends: "@parcel/config-default",
            transformers: {
                '*.js': ['./transformer.js', '...']
            },
        }

    .parcelrc-2:
      {
          extends: "@parcel/config-default",
          transformers: {
              '*.js': ['./transformer-client.js', '...']
          },
      }

    transformer.js:
        const {Transformer} = require('@parcel/plugin');
        module.exports = new Transformer({
            async transform({asset, options}) {
                const code = await asset.getCode();
                if (code.includes('MARKER') && options.featureFlags.exampleFeature) {
                    asset.setCode(code.replace('MARKER', 'REPLACED'));
                }
                return [asset];
            }
        });

    transformer-client.js:
        const {Transformer} = require('@parcel/plugin');
        const {getFeatureFlag} = require('@parcel/feature-flags');
        module.exports = new Transformer({
            async transform({asset, options}) {
                const code = await asset.getCode();
                if (code.includes('MARKER') && getFeatureFlag('exampleFeature')) {
                    asset.setCode(code.replace('MARKER', 'REPLACED'));
                }
                return [asset];
            }
        });
`;
  });

  it('flag should be available in plugins and set from options', async () => {
    await overlayFS.mkdirp(dir);

    const b = await bundle(path.join(dir, 'index.js'), {
      inputFS: overlayFS,
      featureFlags: {exampleFeature: true},
    });
    const output = await run(b);

    assert(
      output.includes('REPLACED'),
      `Expected ${output} to contain 'REPLACED'`,
    );
  });

  it('flag defaults should be available in plugins if not set from options', async () => {
    await overlayFS.mkdirp(dir);

    const b = await bundle(path.join(dir, 'index.js'), {
      inputFS: overlayFS,
    });
    const output = await run(b);

    assert(
      !output.includes('REPLACED'),
      `Expected ${output} to NOT contain 'REPLACED'`,
    );
  });

  it('cache should invalidate on flag switch', async () => {
    await overlayFS.mkdirp(dir);

    const b = await bundle(path.join(dir, 'index.js'), {
      inputFS: overlayFS,
      shouldDisableCache: false,
      featureFlags: {exampleFeature: true},
    });
    const output = await run(b);

    assert(
      output.includes('REPLACED'),
      `Expected ${output} to contain 'REPLACED'`,
    );

    const b2 = await bundle(path.join(dir, 'index.js'), {
      inputFS: overlayFS,
      shouldDisableCache: false,
      featureFlags: {exampleFeature: false},
    });
    const output2 = await run(b2);
    assert(
      !output2.includes('REPLACED'),
      `Expected ${output} to NOT contain 'REPLACED'`,
    );
  });

  it('flag should be available in plugins via client', async () => {
    await overlayFS.mkdirp(dir);

    const b = await bundle(path.join(dir, 'index.js'), {
      inputFS: overlayFS,
      featureFlags: {exampleFeature: true},
      config: path.join(dir, '.parcelrc-2'),
    });
    const output = await run(b);

    assert(
      output.includes('REPLACED'),
      `Expected ${output} to contain 'REPLACED'`,
    );
  });
});
