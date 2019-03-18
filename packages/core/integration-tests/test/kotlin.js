const assert = require('assert');
const {bundle, assertBundleTree, run} = require('@parcel/test-utils');
const commandExists = require('command-exists');

describe('kotlin', () => {
  if (!commandExists.sync('java')) {
    // eslint-disable-next-line no-console
    console.log(
      'Skipping Kotlin tests. Install https://www.java.com/download/ to run them.'
    );
    return;
  }

  it('should produce a basic kotlin bundle', async () => {
    let b = await bundle(__dirname + '/integration/kotlin/index.js');

    await assertBundleTree(b, {
      type: 'js',
      assets: ['test.kt', 'index.js', 'browser.js', 'kotlin.js']
    });

    let output = await run(b);
    assert.equal(output, 5);
  });
});
