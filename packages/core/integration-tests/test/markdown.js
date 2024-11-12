import assert from 'assert';
import path from 'path';
import {assertBundleTree, bundle, outputFS} from '@parcel/test-utils';

describe.skip('markdown', function () {
  it('should support bundling Markdown', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/markdown/index.md'),
    );

    await assertBundleTree(b, {
      name: 'index.html',
      assets: ['index.md'],
      childBundles: [
        {
          type: 'png',
          assets: ['100x100.png'],
          childBundles: [],
        },
      ],
    });

    let files = await outputFS.readdir(path.join(__dirname, '/dist'));
    let html = await outputFS.readFile(
      path.join(__dirname, '/dist/index.html'),
    );
    for (let file of files) {
      let ext = file.match(/\.([0-9a-z]+)(?:[?#]|$)/i)[0];
      if (file !== 'index.html' && ext !== '.map') {
        assert(html.includes(file));
      }
    }
  });
});
