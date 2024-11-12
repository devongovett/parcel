// @flow strict-local
import {
  bundler,
  getNextBuildSuccess,
  inputFS,
  overlayFS,
  run,
  fsFixture,
} from '@parcel/test-utils';
import assert from 'assert';
import path from 'path';
import sinon from 'sinon';
import {NodePackageManager} from '@parcel/package-manager';

import {type Asset} from '@parcel/types';

const CONFIG = Symbol.for('parcel-plugin-config');
let packageManager = new NodePackageManager(inputFS, '/');

describe('incremental bundling', function () {
  let defaultBundlerSpy, customBundlerSpy;
  let assertChangedAssets = (actual: number, expected: number) => {
    assert.equal(
      actual,
      expected,
      `the number of changed assets should be ${expected}, not ${actual}`,
    );
  };

  let assertTimesBundled = (actual: number, expected: number) => {
    assert.equal(
      actual,
      expected,
      `the bundler should have bundled ${expected} time(s), not ${actual}`,
    );
  };

  let getChangedAssetsBeforeRuntimes = (changedAssets: Array<Asset>) => {
    return changedAssets.filter(a => !a.filePath.includes('runtime'));
  };
  beforeEach(async () => {
    let Bundler = (
      await packageManager.require('@parcel/bundler-default', __filename)
    ).default;
    let CustomBundler = await packageManager.require(
      './integration/incremental-bundling/node_modules/parcel-bundler-test',
      __filename,
    );

    defaultBundlerSpy = sinon.spy(Bundler[CONFIG], 'bundle'); // $FlowFixMe[prop-missing]

    customBundlerSpy = sinon.spy(CustomBundler[CONFIG], 'bundle');
  });

  afterEach(() => {
    defaultBundlerSpy.restore();
    customBundlerSpy.restore();
  });

  describe('non-dependency based changes', () => {
    describe('javascript', () => {
      it('add a console log should not bundle by default', async () => {
        let subscription;
        let fixture = path.join(__dirname, '/integration/incremental-bundling');
        try {
          let b = bundler(path.join(fixture, 'index.js'), {
            inputFS: overlayFS,
            shouldDisableCache: false,
          });

          await overlayFS.mkdirp(fixture);
          subscription = await b.watch();

          let event = await getNextBuildSuccess(b);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          await overlayFS.writeFile(
            path.join(fixture, 'index.js'),
            `import {a} from './a';
console.log('index.js');
console.log(a);
console.log('adding a new console');`,
          );

          event = await getNextBuildSuccess(b);
          assertChangedAssets(event.changedAssets.size, 1);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          let result = await b.run();
          let contents = await overlayFS.readFile(
            result.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes(`console.log('adding a new console')`));
        } finally {
          if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      });

      it('disable by setting option to false', async () => {
        let subscription;
        let fixture = path.join(__dirname, '/integration/incremental-bundling');
        try {
          let b = bundler(path.join(fixture, 'index.js'), {
            inputFS: overlayFS,
            shouldDisableCache: false,
            shouldBundleIncrementally: false,
          });

          await overlayFS.mkdirp(fixture);
          subscription = await b.watch();

          let event = await getNextBuildSuccess(b);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          await overlayFS.writeFile(
            path.join(fixture, 'index.js'),
            `import {a} from './a';
console.log('index.js');
console.log(a);
console.log('adding a new console');`,
          );

          event = await getNextBuildSuccess(b);
          assertChangedAssets(event.changedAssets.size, 1);
          assertTimesBundled(defaultBundlerSpy.callCount, 2);

          let result = await b.run();
          let contents = await overlayFS.readFile(
            result.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes(`console.log('adding a new console')`));
        } finally {
          if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      });

      it('add a console log should not bundle', async () => {
        let subscription;
        let fixture = path.join(__dirname, '/integration/incremental-bundling');
        try {
          let b = bundler(path.join(fixture, 'index.js'), {
            inputFS: overlayFS,
            shouldDisableCache: false,
            shouldBundleIncrementally: true,
          });

          await overlayFS.mkdirp(fixture);
          subscription = await b.watch();

          let event = await getNextBuildSuccess(b);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          await overlayFS.writeFile(
            path.join(fixture, 'index.js'),
            `import {a} from './a';
console.log('index.js');
console.log(a);
console.log('adding a new console');`,
          );

          event = await getNextBuildSuccess(b);
          assertChangedAssets(event.changedAssets.size, 1);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          let result = await b.run();
          let contents = await overlayFS.readFile(
            result.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes(`console.log('adding a new console')`));
        } finally {
          if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      });

      it('updating a string value should not bundle', async () => {
        let subscription;
        let fixture = path.join(__dirname, '/integration/incremental-bundling');
        try {
          let b = bundler(path.join(fixture, 'index.js'), {
            inputFS: overlayFS,
            shouldDisableCache: false,
            shouldBundleIncrementally: true,
          });

          await overlayFS.mkdirp(fixture);
          subscription = await b.watch();

          let event = await getNextBuildSuccess(b);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          await overlayFS.writeFile(
            path.join(fixture, 'index.js'),
            `import {a} from './a';
console.log('index.js - updated string');
console.log(a);
`,
          );

          event = await getNextBuildSuccess(b);
          assertChangedAssets(event.changedAssets.size, 1);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          let result = await b.run();
          let contents = await overlayFS.readFile(
            result.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(
            contents.includes(`console.log('index.js - updated string');`),
          );
        } finally {
          if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      });

      it('adding a comment', async () => {
        let subscription;
        let fixture = path.join(__dirname, '/integration/incremental-bundling');
        try {
          let b = bundler(path.join(fixture, 'index.js'), {
            inputFS: overlayFS,
            shouldDisableCache: false,
            shouldBundleIncrementally: true,
          });

          await overlayFS.mkdirp(fixture);
          subscription = await b.watch();

          let event = await getNextBuildSuccess(b);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          await overlayFS.writeFile(
            path.join(fixture, 'index.js'),
            `import {a} from './a';
// test comment
console.log('index.js');
console.log(a);`,
          );

          event = await getNextBuildSuccess(b);
          assertChangedAssets(event.changedAssets.size, 1);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          let result = await b.run();
          let contents = await overlayFS.readFile(
            result.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );
          assert(contents.includes(`// test comment`));
        } finally {
          if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      });

      // this case is similar to applying a patch or restarting parcel with changes
      it('adds multiple non-dependency related changes', async () => {
        let subscription;
        let fixture = path.join(__dirname, '/integration/incremental-bundling');
        try {
          let b = bundler(path.join(fixture, 'index-export.js'), {
            inputFS: overlayFS,
            shouldDisableCache: false,
            shouldBundleIncrementally: true,
          });

          await overlayFS.mkdirp(fixture);
          subscription = await b.watch();

          let event = await getNextBuildSuccess(b);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          await overlayFS.writeFile(
            path.join(fixture, 'index-export.js'),
            `import {a} from './a';
console.log('adding a new console');
module.exports = a;`,
          );

          await overlayFS.writeFile(
            path.join(fixture, 'a.js'),
            `export const a = 'a updated';`,
          );

          event = await getNextBuildSuccess(b);
          assertChangedAssets(event.changedAssets.size, 2);
          assertTimesBundled(defaultBundlerSpy.callCount, 1);

          let result = await b.run();
          let contents = await overlayFS.readFile(
            result.bundleGraph.getBundles()[0].filePath,
            'utf8',
          );

          assert(contents.includes(`console.log('adding a new console')`));

          let bundleOutput = await run(result.bundleGraph);
          assert.equal(bundleOutput, 'a updated');
        } finally {
          if (subscription) {
            await subscription.unsubscribe();
            subscription = null;
          }
        }
      });
    });

    it('update an imported css file', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index-with-css.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        let event = await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'a.css'),
          `html {
  color: red;
}
`,
        );

        event = await getNextBuildSuccess(b);
        assertChangedAssets(event.changedAssets.size, 1);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        let result = await b.run();
        let bundleCSS = result.bundleGraph.getBundles()[1];
        assert.equal(bundleCSS.type, 'css');

        let cssContent = await overlayFS.readFile(bundleCSS.filePath, 'utf8');
        assert(cssContent.includes(`color: red;`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });

    it('update both the js and imported css file', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index-with-css.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        let event = await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'index-with-css.js'),
          `import {a} from './a';
import './a.css';
console.log('index.js');
console.log(a, 'updated');`,
        );

        await overlayFS.writeFile(
          path.join(fixture, 'a.css'),
          `html {
  color: red;
}`,
        );

        event = await getNextBuildSuccess(b);
        assertChangedAssets(event.changedAssets.size, 2);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        let result = await b.run();
        let contents = await overlayFS.readFile(
          result.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );

        assert(contents.includes(`console.log((0, _a.a), 'updated');`));

        let bundleCSS = result.bundleGraph.getBundles()[1];
        assert.equal(bundleCSS.type, 'css');

        let cssContent = await overlayFS.readFile(bundleCSS.filePath, 'utf8');
        assert(cssContent.includes(`color: red;`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });

    it('update the bundles if entry is html and js asset is modified', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index.html'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        let event = await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'index.js'),
          `import {a} from './a';
// test comment
console.log('index.js');
console.log(a);`,
        );

        event = await getNextBuildSuccess(b);
        assertChangedAssets(event.changedAssets.size, 1);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        let result = await b.run();

        let bundleHTML = result.bundleGraph.getBundles()[0];
        assert.equal(bundleHTML.type, 'html');
        let htmlContent = await overlayFS.readFile(bundleHTML.filePath, 'utf8');

        assert(htmlContent.includes(`<html>`));

        let bundleJS = result.bundleGraph.getBundles()[1];
        assert.equal(bundleJS.type, 'js');

        let jsContent = await overlayFS.readFile(bundleJS.filePath, 'utf8');
        assert(jsContent.includes(`// test comment`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });
  });

  describe('dependency based changes should run the bundler', () => {
    it('adding a new dependency', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'index.js'),
          `import {a} from './a';
import {b} from './b';
console.log('index.js', b);
console.log(a);
`,
        );

        let event = await getNextBuildSuccess(b);
        assertChangedAssets(event.changedAssets.size, 2);
        assertTimesBundled(defaultBundlerSpy.callCount, 2);

        let contents = await overlayFS.readFile(
          event.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );

        assert(contents.includes(`console.log('index.js', (0, _b.b));`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });

    it('adding a new dependency of a different type', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'index.js'),
          `import {a} from './a';
import './a.css';
console.log(a);
`,
        );

        let event = await getNextBuildSuccess(b);
        assertChangedAssets(event.changedAssets.size, 2);
        assertTimesBundled(defaultBundlerSpy.callCount, 2);

        // one CSS and one JS bundle
        assert.equal(event.bundleGraph.getBundles().length, 2);

        let contents = await overlayFS.readFile(
          event.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );

        assert(contents.includes(`console.log((0, _a.a));`));

        let bundleCSS = event.bundleGraph.getBundles()[1];
        assert.equal(bundleCSS.type, 'css');

        let cssContent = await overlayFS.readFile(bundleCSS.filePath, 'utf8');
        assert(cssContent.includes(`color: #00f;`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });

    it('adding a new dynamic import', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'index.js'),
          `import {a} from './a';
const b = import('./b');
console.log(a, b);
`,
        );

        let event = await getNextBuildSuccess(b);
        let assets = Array.from(event.changedAssets.values());
        assertChangedAssets(getChangedAssetsBeforeRuntimes(assets).length, 2);
        assertTimesBundled(defaultBundlerSpy.callCount, 2);

        // original bundle and new dynamic import bundle JS bundle
        assert.equal(event.bundleGraph.getBundles().length, 2);

        let contents = await overlayFS.readFile(
          event.bundleGraph.getBundles()[0].filePath,
          'utf8',
        );

        assert(contents.includes(`console.log((0, _a.a), b);`));

        let dynamicBundle = event.bundleGraph.getBundles()[1];
        assert.equal(dynamicBundle.type, 'js');

        let dynamicContent = await overlayFS.readFile(
          dynamicBundle.filePath,
          'utf8',
        );
        assert(
          dynamicContent.includes(`parcelHelpers.export(exports, "b", ()=>b);
const b = 'b';`),
        );
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });

    it('removing a dependency', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        let event = await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        await overlayFS.writeFile(
          path.join(fixture, 'index.js'),
          `// import {a} from './a';
console.log('index.js');`,
        );

        event = await getNextBuildSuccess(b);
        assertChangedAssets(event.changedAssets.size, 1);
        assertTimesBundled(defaultBundlerSpy.callCount, 2);

        let output = await overlayFS.readFile(
          path.join(fixture, 'index.js'),
          'utf8',
        );
        assert(output.includes(`// import {a} from './a'`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });
  });

  describe('other changes that would for a re-bundle', () => {
    it('changing the bundler in parcel configs', async () => {
      let subscription;
      let fixture = path.join(__dirname, '/integration/incremental-bundling');
      try {
        let b = bundler(path.join(fixture, 'index.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(fixture);
        subscription = await b.watch();

        let event = await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);
        assertTimesBundled(customBundlerSpy.callCount, 0);

        await overlayFS.writeFile(
          path.join(fixture, '.parcelrc'),
          JSON.stringify({
            extends: '@parcel/config-default',
            bundler: 'parcel-bundler-test',
          }),
        );

        event = await getNextBuildSuccess(b);
        let assets = Array.from(event.changedAssets.values());
        // should contain all the assets
        assertChangedAssets(getChangedAssetsBeforeRuntimes(assets).length, 3);
        // the default bundler was only called once
        assertTimesBundled(defaultBundlerSpy.callCount, 1);
        // calls the new bundler to rebundle
        assertTimesBundled(customBundlerSpy.callCount, 1);

        let output = await overlayFS.readFile(
          path.join(fixture, 'index.js'),
          'utf8',
        );
        assert(output.includes(`import {a} from './a'`));
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });

    it('changing bundler options', async () => {
      let subscription;
      try {
        await fsFixture(overlayFS, __dirname)`
          index.js:
            export default 1;

          package.json:
            {
              "@parcel/bundler-default": {
                "http": 2
              }
            }

          yarn.lock:`;

        let b = bundler(path.join(__dirname, 'index.js'), {
          inputFS: overlayFS,
          shouldDisableCache: false,
          shouldBundleIncrementally: true,
        });

        await overlayFS.mkdirp(__dirname);
        subscription = await b.watch();

        let event = await getNextBuildSuccess(b);
        assertTimesBundled(defaultBundlerSpy.callCount, 1);

        let pkgFile = path.join(__dirname, 'package.json');
        let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
        await overlayFS.writeFile(
          pkgFile,
          JSON.stringify({
            ...pkg,
            '@parcel/bundler-default': {
              http: 1,
            },
          }),
        );

        event = await getNextBuildSuccess(b);

        // should contain all the assets
        assertChangedAssets(event.changedAssets.size, 2);
        assertTimesBundled(defaultBundlerSpy.callCount, 2);
      } finally {
        if (subscription) {
          await subscription.unsubscribe();
          subscription = null;
        }
      }
    });
  });

  it('changing the namer', async () => {
    let subscription;
    let fixture = path.join(__dirname, '/integration/incremental-bundling');
    try {
      let b = bundler(path.join(fixture, 'index.js'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
        shouldBundleIncrementally: true,
      });

      await overlayFS.mkdirp(fixture);
      subscription = await b.watch();

      let event = await getNextBuildSuccess(b);
      assertTimesBundled(defaultBundlerSpy.callCount, 1);

      await overlayFS.writeFile(
        path.join(fixture, '.parcelrc'),
        JSON.stringify({
          extends: '@parcel/config-default',
          namers: ['parcel-namer-test'],
        }),
      );

      event = await getNextBuildSuccess(b);

      // should contain all the assets
      assertChangedAssets(event.changedAssets.size, 3);
      assertTimesBundled(defaultBundlerSpy.callCount, 2);

      let result = await b.run();
      let bundles = result.bundleGraph.getBundles();
      assert.deepEqual(
        bundles.map(b => b.name),
        bundles.map(b => `${b.id}.${b.type}`),
      );
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });

  it('changing the runtimes', async () => {
    let subscription;
    let fixture = path.join(__dirname, '/integration/incremental-bundling');
    try {
      let b = bundler(path.join(fixture, 'index.js'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
        shouldBundleIncrementally: true,
      });

      await overlayFS.mkdirp(fixture);
      subscription = await b.watch();

      let event = await getNextBuildSuccess(b);
      assertTimesBundled(defaultBundlerSpy.callCount, 1);

      await overlayFS.writeFile(
        path.join(fixture, '.parcelrc'),
        JSON.stringify({
          extends: '@parcel/config-default',
          runtimes: ['parcel-runtime-test'],
        }),
      );

      event = await getNextBuildSuccess(b);

      // should contain all the assets
      let assets = Array.from(event.changedAssets.values());
      assertChangedAssets(getChangedAssetsBeforeRuntimes(assets).length, 3);
      assertTimesBundled(defaultBundlerSpy.callCount, 2);

      let result = await b.run();
      let res = await run(result.bundleGraph, null, {require: false});
      assert.equal(res.runtime_test, true);
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });

  it('changing target options', async () => {
    let subscription;
    let fixture = path.join(__dirname, '/integration/incremental-bundling');
    try {
      let b = bundler(path.join(fixture, 'index.js'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
        shouldBundleIncrementally: true,
      });

      await overlayFS.mkdirp(fixture);
      subscription = await b.watch();

      let event = await getNextBuildSuccess(b);
      assertTimesBundled(defaultBundlerSpy.callCount, 1);
      assertTimesBundled(customBundlerSpy.callCount, 0);

      let pkgFile = path.join(fixture, 'package.json');
      let pkg = JSON.parse(await overlayFS.readFile(pkgFile));
      await overlayFS.writeFile(
        pkgFile,
        JSON.stringify({
          ...pkg,
          targets: {
            esmodule: {
              outputFormat: 'esmodule',
            },
          },
        }),
      );
      event = await getNextBuildSuccess(b);

      assertChangedAssets(event.changedAssets.size, 3);
      assertTimesBundled(defaultBundlerSpy.callCount, 2);

      let output = await overlayFS.readFile(
        path.join(fixture, 'index.js'),
        'utf8',
      );
      assert(output.includes(`import {a} from './a'`));
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });

  it('adding a new the entry', async () => {
    let subscription;
    let fixture = path.join(__dirname, '/integration/incremental-bundling');
    try {
      let b = bundler(path.join(fixture, '*.html'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
        shouldBundleIncrementally: true,
      });

      await overlayFS.mkdirp(fixture);
      subscription = await b.watch();

      let event = await getNextBuildSuccess(b);
      assertTimesBundled(defaultBundlerSpy.callCount, 1);
      assertTimesBundled(customBundlerSpy.callCount, 0);

      await overlayFS.writeFile(
        path.join(fixture, 'index-new-entry.html'),
        '<html />',
      );

      event = await getNextBuildSuccess(b);

      // should contain all the assets
      assertChangedAssets(event.changedAssets.size, 1);
      assertTimesBundled(defaultBundlerSpy.callCount, 2);
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });
  it('changing symbols (adding a new dependency via one symbol)', async () => {
    let subscription;
    let fixture = path.join(__dirname, '/integration/incremental-bundling');
    try {
      let b = bundler(path.join(fixture, 'index-multi-symbol.js'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
        shouldBundleIncrementally: true,
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      });

      await overlayFS.mkdirp(fixture);
      subscription = await b.watch();

      let event = await getNextBuildSuccess(b);
      assertTimesBundled(defaultBundlerSpy.callCount, 1);

      await overlayFS.writeFile(
        path.join(fixture, 'index-multi-symbol.js'),
        `import {a,b,c} from './multi-symbol-util.js';

      console.log('index.js');
      console.log(a,b,c);
      module.exports = {a, b, c};
      `,
      );

      event = await getNextBuildSuccess(b);
      assertChangedAssets(event.changedAssets.size, 1);
      assertTimesBundled(defaultBundlerSpy.callCount, 2);

      let result = await b.run();
      let contents = await overlayFS.readFile(
        result.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(
        /console\.log\(\(0, [^)]+\), \(0, [^)]+\), \(0, [^)]+\)\);/.test(
          contents,
        ),
      );
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });
  it('changing symbols (removing a dependency via one symbol)', async () => {
    let subscription;
    let fixture = path.join(__dirname, '/integration/incremental-bundling');
    try {
      let b = bundler(path.join(fixture, 'index-multi-symbol.js'), {
        inputFS: overlayFS,
        shouldDisableCache: false,
        shouldBundleIncrementally: true,
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      });

      await overlayFS.mkdirp(fixture);
      subscription = await b.watch();

      let event = await getNextBuildSuccess(b);
      assertTimesBundled(defaultBundlerSpy.callCount, 1);

      await overlayFS.writeFile(
        path.join(fixture, 'index-multi-symbol.js'),
        `import {a } from './multi-symbol-util.js';

console.log('index.js');
console.log(a);
module.exports = {a}
`,
      );

      event = await getNextBuildSuccess(b);
      assertChangedAssets(event.changedAssets.size, 1);
      assertTimesBundled(defaultBundlerSpy.callCount, 2);

      let result = await b.run();
      let contents = await overlayFS.readFile(
        result.bundleGraph.getBundles()[0].filePath,
        'utf8',
      );
      assert(/console\.log\(\(0, [^)]+\)\);/.test(contents));

      result.bundleGraph.getBundles()[0].traverseAssets(a => {
        assert(!a.filePath.endsWith('b.js'));
      });
    } finally {
      if (subscription) {
        await subscription.unsubscribe();
        subscription = null;
      }
    }
  });
});
