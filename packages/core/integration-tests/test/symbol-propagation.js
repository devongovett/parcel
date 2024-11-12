import assert from 'assert';
import path from 'path';
import {bundler, fsFixture, overlayFS, run} from '@parcel/test-utils';

describe('symbol propagation', () => {
  it('should handle removed assets from previous failed builds', async () => {
    await fsFixture(overlayFS, __dirname)`
        broken.js:
            module.exports = require('./missing.js');
        working.js:
            module.exports = 'ITS WORKING';
        index.js:
            module.exports = require('./broken.js');`;

    let b = bundler(path.join(__dirname, 'index.js'), {
      inputFS: overlayFS,
      shouldDisableCache: false,
    });

    await assert.rejects(() => b.run(), {
      message: `Failed to resolve './missing.js' from './broken.js'`,
    });

    await overlayFS.writeFile(
      path.join(__dirname, 'index.js'),
      `module.exports = require('./working.js');`,
    );

    let {bundleGraph} = await b.run();

    assert(await run(bundleGraph), 'ITS WORKING');
  });
});
