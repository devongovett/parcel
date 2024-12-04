// @flow strict-local
import assert from 'assert';
import invariant from 'assert';
import path from 'path';
import {
  bundle,
  bundler,
  getNextBuild,
  overlayFS as fs,
  sleep,
  run,
  getNextBuildSuccess,
} from '@parcel/test-utils';
import getPort from 'get-port';
import type {BuildEvent, Asset} from '@parcel/types';
// flowlint-next-line untyped-import:off
import JSDOM from 'jsdom';
import nullthrows from 'nullthrows';

let MessageChannel;
try {
  ({MessageChannel} = require('worker_threads'));
} catch (_) {
  // eslint-disable-next-line no-console
  console.log(
    'Skipping Preact Fast Refresh tests because they require worker_threads',
  );
}

if (MessageChannel) {
  describe('prefresh', function () {
    describe('synchronous', () => {
      const testDir = path.join(__dirname, '/integration/preact-prefresh');

      let b,
        root,
        window,
        subscription,
        randoms = {};

      beforeEach(async () => {
        ({b, root, window, subscription, randoms} = await setup(
          path.join(testDir, 'index.html'),
        ));
      });

      it('retains state in functional components', async function () {
        await fs.mkdirp(testDir);
        await fs.copyFile(
          path.join(testDir, 'Foo.1.js'),
          path.join(testDir, 'Foo.js'),
        );
        assert.equal((await getNextBuild(b)).type, 'buildSuccess');

        // Wait for the hmr-runtime to process the event
        await sleep(100);

        console.log('root.textContent', root.textContent);
        let [, indexNum, appNum, fooText, fooNum] = root.textContent.match(
          /^([\d.]+) ([\d.]+) ([\w]+):([\d.]+)$/,
        );
        assert.equal(randoms.indexNum, indexNum);
        assert.equal(randoms.appNum, appNum);
        assert.equal(randoms.fooNum, fooNum);
        assert.equal(fooText, 'OtherFunctional');
      });

      it('supports changing hooks in functional components', async function () {
        await fs.mkdirp(testDir);
        await fs.copyFile(
          path.join(testDir, 'Foo.2-hooks.js'),
          path.join(testDir, 'Foo.js'),
        );
        assert.equal((await getNextBuild(b)).type, 'buildSuccess');

        // Wait for the hmr-runtime to process the event
        await sleep(100);

        console.log('root.textContent', root.textContent);
        let [, indexNum, appNum, fooText, fooNum, fooNum2] =
          root.textContent.match(
            /^([\d.]+) ([\d.]+) ([\w]+):([\d.]+):([\d.]+)$/,
          );
        assert.equal(randoms.indexNum, indexNum);
        assert.equal(randoms.appNum, appNum);
        assert.notEqual(randoms.fooNum, fooNum);
        assert(fooNum2);
        assert.equal(fooText, 'Hooks');
      });
    });
  });
}

async function setup(entry) {
  let port = await getPort(),
    b,
    window,
    randoms,
    subscription,
    root;

  b = bundler(entry, {
    inputFS: fs,
    outputFS: fs,
    serveOptions: {
      https: false,
      port,
      host: '127.0.0.1',
    },
    hmrOptions: {
      port,
    },
    defaultConfig: path.join(
      __dirname,
      'integration/custom-configs/.parcelrc-prefresh',
    ),
  });

  subscription = await b.watch();
  let bundleEvent: BuildEvent = await getNextBuild(b);
  invariant(bundleEvent.type === 'buildSuccess');
  let bundleGraph = bundleEvent.bundleGraph;
  let dom = await JSDOM.JSDOM.fromURL(
    'http://127.0.0.1:' + port + '/index.html',
    {
      runScripts: 'dangerously',
      resources: 'usable',
      pretendToBeVisual: true,
    },
  );
  window = dom.window;
  await new Promise(res =>
    window.document.addEventListener('load', () => {
      res();
    }),
  );
  window.console.clear = () => {};
  window.MessageChannel = MessageChannel;
  root = window.document.getElementById('root');

  let bundle = nullthrows(bundleGraph.getBundles().find(b => b.type === 'js'));
  let parcelRequire = Object.keys(window).find(k =>
    k.startsWith('parcelRequire'),
  );
  // preact.render
  await window[parcelRequire](
    bundleGraph.getAssetPublicId(bundle.getEntryAssets().pop()),
  ).default();
  await sleep(100);

  let [, indexNum, appNum, fooText, fooNum] = root.textContent.match(
    /^([\d.]+) ([\d.]+) ([\w]+):([\d.]+)$/,
  );
  assert(indexNum);
  assert(appNum);
  assert(fooNum);

  randoms = {indexNum, appNum, fooText, fooNum};

  return {port, b, window, randoms, subscription, root};
}

async function cleanup({window, subscription}) {
  if (window) {
    window.close();
  }
  if (subscription) {
    await subscription.unsubscribe();
  }
}
