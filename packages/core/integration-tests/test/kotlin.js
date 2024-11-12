import assert from 'assert';
import {assertBundleTree, bundle, run} from '@parcel/test-utils';
import commandExists from 'command-exists';

describe.skip('kotlin', function () {
  if (!commandExists.sync('java')) {
    // eslint-disable-next-line no-console
    console.log(
      'Skipping Kotlin tests. Install https://www.java.com/download/ to run them.',
    );
    return;
  }

  it('should produce a basic kotlin bundle', async function () {
    let b = await bundle(__dirname + '/integration/kotlin/index.js');

    await assertBundleTree(b, {
      type: 'js',
      assets: ['test.kt', 'index.js', 'browser.js', 'kotlin.js'],
    });

    let output = await run(b);
    assert.equal(output, 5);
  });
});
