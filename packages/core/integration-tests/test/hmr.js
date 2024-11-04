// @flow strict-local
import assert from 'assert';
import path from 'path';
import {
  bundler,
  getNextBuild,
  getNextBuildSuccess,
  ncp,
  outputFS,
  overlayFS,
  sleep,
  run,
  request,
} from '@parcel/test-utils';
import WebSocket from 'ws';
import json5 from 'json5';
import getPort from 'get-port';
// flowlint-next-line untyped-import:off
import JSDOM from 'jsdom';
import nullthrows from 'nullthrows';

const config = path.join(
  __dirname,
  './integration/custom-configs/.parcelrc-dev-server',
);

async function closeSocket(ws: WebSocket) {
  ws.close();
  await new Promise(resolve => {
    ws.once('close', resolve);
  });
}
// flowlint-next-line unclear-type:off
async function openSocket(uri: string, opts: any) {
  let ws = new WebSocket(uri, opts);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return ws;
}

async function nextWSMessage(ws: WebSocket) {
  return json5.parse(await new Promise(resolve => ws.once('message', resolve)));
}

describe('hmr', function () {
  let subscription, ws;

  async function testHMRClient(
    name: string,
    updates:
      | ((
          // $FlowFixMe[unclear-type]
          Array<any>,
        ) => {[string]: string})
      // $FlowFixMe[unclear-type]
      | Array<(Array<any>) => {[string]: string}>,
  ) {
    await ncp(
      path.join(__dirname, '/integration/', name),
      path.join(__dirname, '/input'),
    );

    let port = await getPort();
    let b = bundler(path.join(__dirname, '/input/index.js'), {
      hmrOptions: {
        https: false,
        port,
        host: 'localhost',
      },
      inputFS: overlayFS,
      config,
    });

    subscription = await b.watch();
    let {bundleGraph} = await getNextBuildSuccess(b);
    ws = await openSocket('ws://localhost:' + port);

    let outputs = [];
    let reloaded = false;
    await run(bundleGraph, {
      output(o) {
        outputs.push(o);
      },
      location: {
        reload() {
          reloaded = true;
          outputs = [];
        },
      },
    });

    for (let update of [].concat(updates)) {
      // Fixup the prototypes so that strict assertions work
      let fsUpdates = update(JSON.parse(JSON.stringify(outputs)));
      for (let f in fsUpdates) {
        await overlayFS.writeFile(
          path.join(__dirname, '/input/', f),
          fsUpdates[f],
        );
      }

      await nextWSMessage(nullthrows(ws));
      await sleep(100);
    }

    // Fixup the prototypes so that strict assertions work
    return {
      outputs: JSON.parse(JSON.stringify(outputs)),
      reloaded,
      bundleGraph,
    };
  }

  afterEach(async () => {
    if (ws) {
      await closeSocket(ws);
      ws = null;
    }

    if (subscription) {
      await subscription.unsubscribe();
      subscription = null;
    }
  });

  describe('hmr server', () => {
    beforeEach(async function () {
      await outputFS.rimraf(path.join(__dirname, '/input'));
      await ncp(
        path.join(__dirname, '/integration/commonjs'),
        path.join(__dirname, '/input'),
      );
    });

    it('should emit an HMR update for the file that changed', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      ws = await openSocket('ws://localhost:' + port);

      outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'exports.a = 5;\nexports.b = 5;',
      );

      let message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'update');

      // Figure out why output doesn't change...
      let localAsset = message.assets.find(asset =>
        asset.output.includes('exports.a = 5;\nexports.b = 5;\n'),
      );
      assert(!!localAsset);
      assert(localAsset.output.includes('//# sourceMappingURL'));
      assert(localAsset.output.includes('//# sourceURL'));
    });

    it('should emit an HMR update for all new dependencies along with the changed file', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      ws = await openSocket('ws://localhost:' + port);

      outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"); exports.a = 5; exports.b = 5;',
      );

      let message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'update');

      assert.equal(message.assets.length, 1);
    });

    it('should emit an HMR error on bundle failure', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      ws = await openSocket('ws://localhost:' + port);

      outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"; exports.a = 5; exports.b = 5;',
      );

      let message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'error');

      assert(!!message.diagnostics, 'Should contain a diagnostics key');
      assert(!!message.diagnostics.html, 'Should contain a html diagnostic');
      assert(!!message.diagnostics.ansi, 'Should contain an ansi diagnostic');
    });

    it('should emit an HMR error to new connections after a bundle failure', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      await outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"; exports.a = 5; exports.b = 5;',
      );

      ws = await openSocket('ws://localhost:' + port);
      let message = await nextWSMessage(ws);

      assert.equal(message.type, 'error');
    });

    it('should emit an HMR update after error has been resolved', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      ws = await openSocket('ws://localhost:' + port);

      await outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"; exports.a = 5; exports.b = 5;',
      );

      let message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'error');

      await outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"); exports.a = 5; exports.b = 5;',
      );

      message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'update');
    });

    it('should make a secure connection', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        serveOptions: {
          https: true,
          port,
          host: 'localhost',
        },
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      ws = await openSocket('wss://localhost:' + port, {
        rejectUnauthorized: false,
      });

      await outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'exports.a = 5;\nexports.b = 5;',
      );

      let message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'update');
    });

    it('should make a secure connection with custom certificate', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        serveOptions: {
          https: {
            key: path.join(__dirname, '/integration/https/private.pem'),
            cert: path.join(__dirname, '/integration/https/primary.crt'),
          },
          port,
          host: 'localhost',
        },
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      await getNextBuild(b);

      ws = await openSocket('wss://localhost:' + port, {
        rejectUnauthorized: false,
      });

      outputFS.writeFile(
        path.join(__dirname, '/input/local.js'),
        'exports.a = 5;\nexports.b = 5;',
      );

      let message = await nextWSMessage(nullthrows(ws));

      assert.equal(message.type, 'update');
    });

    it('should respond to requests for assets by id', async function () {
      let port = await getPort();
      let b = bundler(path.join(__dirname, '/input/index.js'), {
        serveOptions: {port},
        hmrOptions: {port},
        inputFS: overlayFS,
        config,
      });

      subscription = await b.watch();
      let event = await getNextBuild(b);

      let bundleGraph = nullthrows(event.bundleGraph);
      let asset = nullthrows(bundleGraph.getBundles()[0].getMainEntry());
      let contents = await request('/__parcel_hmr/' + asset.id, port);
      let publicId = nullthrows(bundleGraph).getAssetPublicId(asset);
      assert(
        contents.startsWith(
          `parcelHotUpdate['${publicId}'] = function (require, module, exports) {`,
        ),
      );
      assert(contents.includes('//# sourceMappingURL'));
      assert(contents.includes('//# sourceURL'));
    });
  });

  // TODO: add test for 4532 (`require` call in modified asset in child bundle where HMR runtime runs in parent bundle)
  describe('hmr runtime', () => {
    beforeEach(async () => {
      await outputFS.rimraf(path.join(__dirname, '/input'));
    });

    it('should support self accepting', async function () {
      let {outputs} = await testHMRClient('hmr-accept-self', outputs => {
        assert.deepStrictEqual(outputs, [
          ['other', 1],
          ['local', 1],
          ['index', 1],
        ]);

        return {
          'other.js': 'export const value = 3; output(["other", value]);',
        };
      });

      assert.deepStrictEqual(outputs, [
        ['other', 1],
        ['local', 1],
        ['index', 1],
        ['other', 3],
        ['local', 3],
      ]);
    });

    it('should bubble through parents', async function () {
      let {outputs} = await testHMRClient('hmr-bubble', outputs => {
        assert.deepStrictEqual(outputs, [
          ['other', 1],
          ['local', 1],
          ['index', 1],
        ]);

        return {
          'other.js': 'export const value = 3; output(["other", value]);',
        };
      });

      assert.deepStrictEqual(outputs, [
        ['other', 1],
        ['local', 1],
        ['index', 1],
        ['other', 3],
        ['local', 3],
        ['index', 3],
      ]);
    });

    it('should call dispose callbacks', async function () {
      let {outputs} = await testHMRClient('hmr-dispose', outputs => {
        assert.deepStrictEqual(outputs, [
          ['eval:other', 1, null],
          ['eval:local', 1, null],
          ['eval:index', 1, null],
        ]);

        return {
          'other.js': `export const value = 3;
output(["eval:other", value, module.hot.data]);
module.hot.dispose((data) => {
  output(["dispose:other", value]);
  data.value = value;
})
`,
        };
      });

      // Webpack:
      // ["eval:other", 1, undefined]
      // ["eval:local", 1, undefined]
      // ["eval:index", 1, undefined]
      // ["dispose:index", 1]
      // ["dispose:local", 1]
      // ["dispose:other", 1]
      // ["eval:other", 3, {value: 1}]
      // ["eval:local", 3, {value: 1}]
      // ["eval:index", 3, {value: 1}]
      assert.deepStrictEqual(outputs, [
        ['eval:other', 1, null],
        ['eval:local', 1, null],
        ['eval:index', 1, null],
        ['dispose:other', 1],
        ['dispose:local', 1],
        ['dispose:index', 1],
        ['eval:other', 3, {value: 1}],
        ['eval:local', 3, {value: 1}],
        ['eval:index', 3, {value: 1}],
      ]);
    });

    it('should work with circular dependencies', async function () {
      let {outputs} = await testHMRClient('hmr-circular', outputs => {
        assert.deepEqual(outputs, [3]);

        return {
          'local.js':
            "var other = require('./index.js'); exports.a = 5; exports.b = 5;",
        };
      });

      assert.deepEqual(outputs, [3, 10]);
    });

    it('should reload if not accepted', async function () {
      let {reloaded} = await testHMRClient('hmr-reload', outputs => {
        assert.deepEqual(outputs, [3]);
        return {
          'local.js': 'exports.a = 5; exports.b = 5;',
        };
      });

      assert(reloaded);
    });

    it('should reload when modifying the entry', async function () {
      let {reloaded} = await testHMRClient('hmr-reload', outputs => {
        assert.deepEqual(outputs, [3]);
        return {
          'index.js': 'output(5)',
        };
      });

      assert(reloaded);
    });

    it('should work with multiple parents', async function () {
      let {outputs} = await testHMRClient('hmr-multiple-parents', outputs => {
        assert.deepEqual(outputs, ['a: fn1 b: fn2']);
        return {
          'fn2.js': 'export function fn2() { return "UPDATED"; }',
        };
      });

      assert.deepEqual(outputs, ['a: fn1 b: fn2', 'a: fn1 b: UPDATED']);
    });

    it('should reload if only one parent accepts', async function () {
      let {reloaded} = await testHMRClient(
        'hmr-multiple-parents-reload',
        outputs => {
          assert.deepEqual(outputs, ['a: fn1', 'b: fn2']);
          return {
            'fn2.js': 'export function fn2() { return "UPDATED"; }',
          };
        },
      );

      assert(reloaded);
    });

    it('should work across bundles', async function () {
      let {reloaded} = await testHMRClient('hmr-dynamic', outputs => {
        assert.deepEqual(outputs, [3]);
        return {
          'local.js': 'exports.a = 5; exports.b = 5;',
        };
      });

      // assert.deepEqual(outputs, [3, 10]);
      assert(reloaded); // TODO: this should eventually not reload...
    });

    it('should work with urls', async function () {
      let search;
      let {outputs} = await testHMRClient('hmr-url', outputs => {
        assert.equal(outputs.length, 1);
        let url = new URL(outputs[0]);
        assert(/test\.[0-9a-f]+\.txt/, url.pathname);
        assert(!isNaN(url.search.slice(1)));
        search = url.search;
        return {
          'test.txt': 'yo',
        };
      });

      assert.equal(outputs.length, 2);
      let url = new URL(outputs[1]);
      assert(/test\.[0-9a-f]+\.txt/, url.pathname);
      assert(!isNaN(url.search.slice(1)));
      assert.notEqual(url.search, search);
    });

    it('should clean up orphaned assets when deleting a dependency', async function () {
      let search;
      let {outputs} = await testHMRClient('hmr-url', [
        outputs => {
          assert.equal(outputs.length, 1);
          let url = new URL(outputs[0]);
          assert(/test\.[0-9a-f]+\.txt/, url.pathname);
          assert(!isNaN(url.search.slice(1)));
          search = url.search;
          return {
            'index.js': 'output("yo"); module.hot.accept();',
          };
        },
        outputs => {
          assert.equal(outputs.length, 2);
          assert.equal(outputs[1], 'yo');
          return {
            'index.js':
              'output(new URL("test.txt", import.meta.url)); module.hot.accept();',
          };
        },
      ]);

      assert.equal(outputs.length, 3);
      let url = new URL(outputs[2]);
      assert(/test\.[0-9a-f]+\.txt/, url.pathname);
      assert(!isNaN(url.search.slice(1)));
      assert.notEqual(url.search, search);
    });

    it('should have correct source locations in errors', async function () {
      let {outputs, bundleGraph} = await testHMRClient(
        'hmr-accept-self',
        () => {
          return {
            'local.js': 'output(new Error().stack);',
          };
        },
      );

      let asset = bundleGraph
        .getBundles()[0]
        .traverseAssets((asset, _, actions) => {
          if (asset.filePath.endsWith('local.js')) {
            actions.stop();
            return asset;
          }
        });

      let stack = outputs.pop();
      assert(stack.includes('/__parcel_hmr/' + nullthrows(asset).id));
    });

    /*
    it.skip('should accept HMR updates in the runtime after an initial error', async function() {
      await fs.mkdirp(path.join(__dirname, '/input'));
      fs.writeFile(
        path.join(__dirname, '/input/index.js'),
        'module.hot.accept();throw new Error("Something");\noutput(123);',
      );

      let b = bundler(path.join(__dirname, '/input/index.js'), {
        watch: true,
        hmr: true,
      });
      let bundle = await b.bundle();

      let outputs = [];
      let errors = [];

      var ctx = prepareBrowserContext(bundle, {
        output(o) {
          outputs.push(o);
        },
        error(e) {
          errors.push(e);
        },
      });
      vm.createContext(ctx);
      vm.runInContext(
        `try {
          ${(await fs.readFile(bundle.name)).toString()}
        } catch(e) {
          error(e);
        }`,
        ctx,
      );

      assert.deepEqual(outputs, []);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].message, 'Something');

      await sleep(100);
      fs.writeFile(path.join(__dirname, '/input/index.js'), 'output(123);');

      // await nextEvent(b, 'bundled');
      assert.deepEqual(outputs, [123]);
      assert.equal(errors.length, 1);
    });

    it.skip('should call dispose and accept callbacks', async function() {
      await ncp(
        path.join(__dirname, '/integration/hmr-callbacks'),
        path.join(__dirname, '/input'),
      );

      let port = await getPort();
      let b = await bundle(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {
          https: false,
          port,
          host: 'localhost',
        },
        env: {
          HMR_HOSTNAME: 'localhost',
          HMR_PORT: port,
        },
        watch: true,
      });

      let outputs = [];
      let moduleId = '';

      await run(b, {
        reportModuleId(id) {
          moduleId = id;
        },
        output(o) {
          outputs.push(o);
        },
      });

      assert.deepEqual(outputs, [3]);

      let ws = new WebSocket('ws://localhost:' + port);

      await sleep(50);
      fs.writeFile(
        path.join(__dirname, '/input/local.js'),
        'exports.a = 5; exports.b = 5;',
      );

      await nextWSMessage(ws);
      await sleep(50);

      assert.notEqual(moduleId, undefined);
      assert.deepEqual(outputs, [
        3,
        'dispose-' + moduleId,
        10,
        'accept-' + moduleId,
      ]);
    });

    it.skip('should trigger a page reload when a new bundle is created', async function() {
      await ncp(
        path.join(__dirname, '/integration/hmr-new-bundle'),
        path.join(__dirname, '/input'),
      );

      let b = bundler(path.join(__dirname, '/input/index.html'), {
        watch: true,
        hmr: true,
      });
      let bundle = await b.bundle();

      let ctx = await run([...bundle.childBundles][0], {}, {require: false});
      let spy = sinon.spy(ctx.location, 'reload');

      await sleep(50);
      assert(spy.notCalled);

      await sleep(100);
      fs.writeFile(
        path.join(__dirname, '/input/index.js'),
        'import "./index.css"',
      );

      // await nextEvent(b, 'bundled');
      assert(spy.calledOnce);

      let contents = await fs.readFile(
        path.join(__dirname, '/dist/index.html'),
        'utf8',
      );
      assert(contents.includes('.css'));
    });

    it.skip('should log emitted errors and show an error overlay', async function() {
      await ncp(
        path.join(__dirname, '/integration/commonjs'),
        path.join(__dirname, '/input'),
      );

      let port = await getPort();
      let b = await bundle(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {
          https: false,
          port,
          host: 'localhost',
        },
        env: {
          HMR_HOSTNAME: 'localhost',
          HMR_PORT: port,
        },
        watch: true,
      });

      let logs = [];
      let ctx = await run(
        b,
        {
          console: {
            error(msg) {
              logs.push(msg);
            },
            log() {},
            clear() {},
          },
        },
        {require: false},
      );

      let spy = sinon.spy(ctx.document.body, 'appendChild');
      let ws = new WebSocket('ws://localhost:' + port);

      await sleep(50);
      fs.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"; exports.a = 5; exports.b = 5;',
      );

      await nextWSMessage(ws);
      await sleep(50);

      assert.equal(logs.length, 1);
      assert(logs[0].trim().startsWith('[parcel] 🚨'));
      assert(spy.calledOnce);
    });

    it.skip('should log when errors resolve', async function() {
      await ncp(
        path.join(__dirname, '/integration/commonjs'),
        path.join(__dirname, '/input'),
      );

      let port = await getPort();
      let b = await bundle(path.join(__dirname, '/input/index.js'), {
        hmrOptions: {
          https: false,
          port,
          host: 'localhost',
        },
        env: {
          HMR_HOSTNAME: 'localhost',
          HMR_PORT: port,
        },
        watch: true,
      });

      let logs = [];
      let ctx = await run(
        b,
        {
          console: {
            error(msg) {
              logs.push(msg);
            },
            log(msg) {
              logs.push(msg);
            },
            clear() {},
          },
          location: {hostname: 'localhost', reload: function() {}},
        },
        {require: false},
      );

      let appendSpy = sinon.spy(ctx.document.body, 'appendChild');
      let removeSpy = sinon.spy(ctx.document.getElementById('tmp'), 'remove');
      let ws = new WebSocket('ws://localhost:' + port);

      await sleep(50);
      fs.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"; exports.a = 5; exports.b = 5;',
      );

      await nextWSMessage(ws);
      await sleep(50);

      assert(appendSpy.called);

      await sleep(50);
      fs.writeFile(
        path.join(__dirname, '/input/local.js'),
        'require("fs"); exports.a = 5; exports.b = 5;',
      );
      await nextWSMessage(ws);
      await sleep(50);

      assert(removeSpy.called);

      // assert.equal(logs.length, 2);
      assert(logs[0].trim().startsWith('[parcel] 🚨'));
      assert(logs[1].trim().startsWith('[parcel] ✨'));
    });*/

    it('should update CSS link tags when a CSS asset is changed', async () => {
      let testDir = path.join(__dirname, '/input');
      await overlayFS.rimraf(testDir);
      await overlayFS.mkdirp(testDir);
      await ncp(path.join(__dirname, '/integration/hmr-css'), testDir);

      let port = await getPort();
      let b = bundler(path.join(testDir, 'index.html'), {
        inputFS: overlayFS,
        outputFS: overlayFS,
        serveOptions: {
          https: false,
          port,
          host: '127.0.0.1',
        },
        hmrOptions: {port},
        shouldContentHash: false,
        config,
      });

      subscription = await b.watch();
      let bundleEvent = await getNextBuild(b);
      assert.equal(bundleEvent.type, 'buildSuccess');

      let window;
      try {
        let dom = await JSDOM.JSDOM.fromURL(
          'http://127.0.0.1:' + port + '/index.html',
          {
            runScripts: 'dangerously',
            resources: 'usable',
            pretendToBeVisual: true,
          },
        );
        let _window = (window = dom.window); // For Flow
        window.WebSocket = WebSocket;
        await new Promise(res =>
          dom.window.document.addEventListener('load', () => {
            res();
          }),
        );
        _window.console.clear = () => {};
        _window.console.warn = () => {};

        let initialHref = _window.document.querySelector('link').href;

        await overlayFS.copyFile(
          path.join(testDir, 'index.2.css'),
          path.join(testDir, 'index.css'),
        );
        assert.equal((await getNextBuild(b)).type, 'buildSuccess');
        await sleep(200);

        let newHref = _window.document.querySelector('link').href;

        assert.notStrictEqual(initialHref, newHref);
      } finally {
        if (window) {
          window.close();
        }
      }
    });

    it('should handle CSS Modules update correctly', async () => {
      let testDir = path.join(__dirname, '/input');
      await overlayFS.rimraf(testDir);
      await overlayFS.mkdirp(testDir);
      await ncp(path.join(__dirname, '/integration/hmr-css-modules'), testDir);

      let port = await getPort();
      let b = bundler(path.join(testDir, 'index.html'), {
        inputFS: overlayFS,
        outputFS: overlayFS,
        serveOptions: {
          https: false,
          port,
          host: '127.0.0.1',
        },
        hmrOptions: {port},
        shouldContentHash: false,
        config,
      });

      subscription = await b.watch();
      let bundleEvent = await getNextBuild(b);
      assert.equal(bundleEvent.type, 'buildSuccess');

      let window;
      try {
        let dom = await JSDOM.JSDOM.fromURL(
          'http://127.0.0.1:' + port + '/index.html',
          {
            runScripts: 'dangerously',
            resources: 'usable',
            pretendToBeVisual: true,
          },
        );
        let _window = (window = dom.window); // For Flow
        window.WebSocket = WebSocket;
        await new Promise(res =>
          dom.window.document.addEventListener('load', () => {
            res();
          }),
        );
        _window.console.clear = () => {};
        _window.console.warn = () => {};

        let initialHref = _window.document.querySelector('link').href;

        await overlayFS.copyFile(
          path.join(testDir, 'index2.module.css'),
          path.join(testDir, 'index.module.css'),
        );
        assert.equal((await getNextBuild(b)).type, 'buildSuccess');
        await sleep(200);

        let newHref = _window.document.querySelector('link').href;

        assert.notStrictEqual(initialHref, newHref);
      } finally {
        if (window) {
          window.close();
        }
      }
    });
  });
});
