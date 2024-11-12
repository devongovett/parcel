// @flow
import assert from 'assert';
import path from 'path';
import {bundle, fsFixture, overlayFS} from '@parcel/test-utils';
import {loadGraphs} from '../../../dev/query/src';

describe('parcel-query', () => {
  it('loadGraphs', async function () {
    let entries = 'index.js';
    let options = {
      mode: 'production',
      defaultTargetOptions: {
        shouldScopeHoist: false,
      },
      shouldDisableCache: false,
      inputFS: overlayFS,
      cacheDir: path.join(__dirname, '.parcel-cache'),
    };

    await fsFixture(overlayFS)`
        index.js:
            export default 1;`;

    await bundle(entries, options);

    const {assetGraph, bundleGraph, requestTracker, bundleInfo} =
      await loadGraphs(options.cacheDir);

    assert(bundleInfo, 'Could not load bundleInfo');
    assert(bundleGraph, 'Could not load bundleGraph');
    assert(assetGraph, 'Could not load assetGraph');
    assert(requestTracker, 'Count not load requestTracker');
  });
});
