// @flow strict-local

import assert from 'assert';
import path from 'path';
import {bundle, distDir, outputFS, run} from '@parcel/test-utils';

class Blob {
  data;
  constructor(data) {
    this.data = data;
  }
}

const URL = {
  createObjectURL(blob) {
    assert(blob instanceof Blob);
    return `data:application/javascript,${encodeURIComponent(blob.data)}`;
  },
};

describe('blob urls', () => {
  it('should inline compiled content as a blob url with `blob-url:*` imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/blob-url/index.js'),
    );

    class Worker {
      constructor(src) {
        created.push(src);
      }
      postMessage() {}
    }

    let created = [];
    await run(b, {
      Worker,
      Blob,
      URL,
    });
    assert.equal(created.length, 1);
    assert(created[0].startsWith('data:application/javascript,'));

    let bundleContent = await outputFS.readFile(
      path.join(distDir, 'index.js'),
      'utf8',
    );
    assert(bundleContent.includes('new Worker(require('));
    assert(
      bundleContent.includes(
        "module.exports = URL.createObjectURL(new Blob([\"'use strict';\\n// modules are defined as an array\\n",
      ),
    );
    assert(
      bundleContent.includes(
        'self.postMessage(\\"this should appear in the bundle\\\\n\\")',
      ),
    );
  });

  it('should inline minified content as a blob url with `blob-url:*` imports', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/blob-url/index.js'),
      {
        defaultTargetOptions: {
          shouldOptimize: true,
        },
      },
    );

    class Worker {
      constructor(src) {
        created.push(src);
      }
      postMessage() {}
    }

    let created = [];
    await run(b, {
      Worker,
      Blob,
      URL,
    });
    assert.equal(created.length, 1);
    assert(created[0].startsWith('data:application/javascript,'));

    let bundleContent = await outputFS.readFile(
      path.join(distDir, 'index.js'),
      'utf8',
    );
    assert(bundleContent.includes('new Worker('));
    assert(
      bundleContent.includes(
        '.exports=URL.createObjectURL(new Blob([\'"use strict";!function(',
      ),
    );
    assert(
      bundleContent.includes(
        'self.postMessage("this should appear in the bundle\\\\n")',
      ),
    );
  });
});
