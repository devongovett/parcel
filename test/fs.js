const assert = require('assert');
const fs = require('fs');
const {bundle, run, assertBundleTree} = require('./utils');

describe('fs', function() {
  describe('--target=browser', function() {
    it('should inline a file as a string', async function() {
      let b = await bundle(__dirname + '/integration/fs/index.js');
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should inline a file as a buffer', async function() {
      let b = await bundle(__dirname + '/integration/fs-buffer/index.js');
      let output = run(b);
      assert.equal(output.constructor.name, 'Buffer');
      assert.equal(output.length, 5);
    });

    it('should inline a file with fs require alias', async function() {
      let b = await bundle(__dirname + '/integration/fs-alias/index.js');
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should inline a file with fs require inline', async function() {
      let b = await bundle(__dirname + '/integration/fs-inline/index.js');
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should inline a file with fs require assignment', async function() {
      let b = await bundle(__dirname + '/integration/fs-assign/index.js');
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should inline a file with fs require assignment alias', async function() {
      let b = await bundle(__dirname + '/integration/fs-assign-alias/index.js');
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should inline a file with fs require destructure', async function() {
      let b = await bundle(__dirname + '/integration/fs-destructure/index.js');
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should inline a file with fs require destructure assignment', async function() {
      let b = await bundle(
        __dirname + '/integration/fs-destructure-assign/index.js'
      );
      let output = run(b);
      assert.equal(output, 'hello');
    });

    it('should not evaluate fs calls when package.browser.fs is false', async function() {
      let b = await bundle(
        __dirname + '/integration/resolve-entries/ignore-fs.js'
      );

      assertBundleTree(b, {
        name: 'ignore-fs.js',
        // empty.js is generated by require('fs'), it gets mocked with an empty module
        assets: ['_empty.js', 'ignore-fs.js', 'index.js'],
        childBundles: [
          {
            type: 'map'
          }
        ]
      });

      let output = run(b);

      assert.equal(typeof output.test, 'function');
      assert.equal(output.test(), 'test-pkg-ignore-fs-ok');
    });

    // TODO: check if the logger has warned the user
    it('should ignore fs calls when the filename is not evaluable', async function() {
      let b = await bundle(
        __dirname + '/integration/fs-file-non-evaluable/index.js'
      );
      let thrown = false;

      try {
        run(b);
      } catch (e) {
        assert.equal(e.message, 'require(...).readFileSync is not a function');

        thrown = true;
      }

      assert.equal(thrown, true);
    });

    it('should ignore fs calls when the options are not evaluable', async function() {
      let b = await bundle(
        __dirname + '/integration/fs-options-non-evaluable/index.js'
      );
      let thrown = false;

      try {
        run(b);
      } catch (e) {
        assert.equal(e.message, 'require(...).readFileSync is not a function');

        thrown = true;
      }

      assert.equal(thrown, true);
    });
  });

  describe('--target=node', function() {
    it('should leave an attempt to read a file unchanged', async function() {
      let b = await bundle(__dirname + '/integration/fs/index.js', {
        target: 'node'
      });

      assertBundleTree(b, {
        name: 'index.js',
        assets: ['index.js'],
        childBundles: [
          {
            type: 'map'
          }
        ]
      });

      assert(fs.readFileSync(b.name).includes("require('fs')"));
      assert(fs.readFileSync(b.name).includes('readFileSync'));

      fs.writeFileSync(b.entryAsset.options.outDir + '/test.txt', 'hey');
      let output = run(b);
      assert.equal(output, 'hey');
    });
  });

  describe('--target=electron', function() {
    it('should leave an attempt to read a file unchanged', async function() {
      let b = await bundle(__dirname + '/integration/fs/index.js', {
        target: 'electron'
      });

      assertBundleTree(b, {
        name: 'index.js',
        assets: ['index.js'],
        childBundles: [
          {
            type: 'map'
          }
        ]
      });

      assert(fs.readFileSync(b.name).includes("require('fs')"));
      assert(fs.readFileSync(b.name).includes('readFileSync'));

      fs.writeFileSync(b.entryAsset.options.outDir + '/test.txt', 'hey');
      let output = run(b);
      assert.equal(output, 'hey');
    });
  });
});
