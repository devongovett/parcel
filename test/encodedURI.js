const assert = require('assert');
const fs = require('fs');
const {bundle, assertBundleTree, tmpPath} = require('./utils');

describe('encodedURI', function() {
  it('should support bundling files which names in encoded URI', async function() {
    let b = await bundle(__dirname + '/integration/encodedURI/index.html');

    assertBundleTree(b, {
      name: 'index.html',
      assets: ['index.html'],
      childBundles: [
        {
          type: 'jpg',
          assets: ['日本語.jpg'],
          childBundles: []
        }
      ]
    });

    let files = fs.readdirSync(tmpPath('dist'));
    let html = fs.readFileSync(tmpPath('dist', 'index.html'));
    for (let file of files) {
      if (file !== 'index.html') {
        assert(html.includes(file));
      }
    }
  });
});
