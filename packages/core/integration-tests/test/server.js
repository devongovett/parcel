// @flow strict-local
import assert from 'assert';
import invariant from 'assert';
import path from 'path';
import {
  assertBundles,
  bundler,
  getNextBuild,
  inputFS,
  outputFS,
  overlayFS,
  ncp,
  request as get,
  requestRaw as getRaw,
} from '@parcel/test-utils';
import https from 'https';
import getPort from 'get-port';
import type {BuildEvent} from '@parcel/types';

const distDir = path.resolve(__dirname, '.parcel-cache/dist');
const config = path.join(
  __dirname,
  './integration/custom-configs/.parcelrc-dev-server',
);

describe('server', function () {
  let subscription;

  afterEach(async () => {
    if (subscription) {
      await subscription.unsubscribe();
    }
    subscription = null;
  });

  it('should serve files', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/index.js', port);
    let distFile = await outputFS.readFile(
      path.join(distDir, 'index.js'),
      'utf8',
    );

    assert.equal(data, distFile);
  });

  it('should include content length for HEAD requests', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let result = await getRaw('/index.js', port, {method: 'HEAD'});
    let distFile = await outputFS.readFile(path.join(distDir, 'index.js'));
    assert.strictEqual(
      result.res.headers['content-length'],
      String(distFile.byteLength),
    );
    assert.strictEqual(result.data, '');
  });

  it('should serve source files', async function () {
    let port = await getPort();
    let inputPath = path.join(__dirname, '/integration/commonjs/index.js');
    let b = bundler(inputPath, {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get(
      '/__parcel_source_root/integration/commonjs/index.js',
      port,
    );
    let inputFile = await inputFS.readFile(inputPath, 'utf8');

    assert.equal(data, inputFile);
  });

  it('should serve sourcemaps', async function () {
    let port = await getPort();
    let inputPath = path.join(__dirname, '/integration/commonjs/index.js');
    let b = bundler(inputPath, {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/index.js.map', port);
    let distFile = await outputFS.readFile(
      path.join(distDir, 'index.js.map'),
      'utf8',
    );

    assert.equal(data, distFile);
  });

  it('should serve a default page if the main bundle is an HTML asset', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/html/index.html'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let rootIndex = await outputFS.readFile(
      path.join(distDir, 'index.html'),
      'utf8',
    );
    let other = await outputFS.readFile(
      path.join(distDir, 'other.html'),
      'utf8',
    );
    let fooIndex = await outputFS.readFile(
      path.join(distDir, 'foo/index.html'),
      'utf8',
    );
    let fooOther = await outputFS.readFile(
      path.join(distDir, 'foo/other.html'),
      'utf8',
    );

    assert.equal(await get('/', port), rootIndex);
    assert.equal(await get('/something', port), rootIndex);
    assert.equal(await get('/other', port), other);
    assert.equal(await get('/foo', port), fooIndex);
    assert.equal(await get('/foo?foo=bar', port), fooIndex);
    assert.equal(await get('/foo/', port), fooIndex);
    assert.equal(await get('/foo/bar', port), fooIndex);
    assert.equal(await get('/foo/other', port), fooOther);
    assert.equal(await get('/foo/other?foo=bar', port), fooOther);
  });

  it('should serve a default page if the single HTML bundle is not called index', async function () {
    let port = await getPort();
    let inputPath = path.join(__dirname, '/integration/html/other.html');
    let b = bundler(inputPath, {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let rootIndexFile = await outputFS.readFile(
      path.join(distDir, 'other.html'),
      'utf8',
    );

    let data = await get('/', port);
    assert.equal(data, rootIndexFile);

    data = await get('/foo', port);
    assert.equal(data, rootIndexFile);

    data = await get('/foo/bar', port);
    assert.equal(data, rootIndexFile);
  });

  it('should serve a default page if the main bundle is an HTML asset with package.json#source', async function () {
    let port = await getPort();
    let inputPath = path.join(__dirname, '/integration/html-pkg-source/');
    let b = bundler(inputPath, {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    let event: BuildEvent = await getNextBuild(b);
    invariant(event.type === 'buildSuccess');
    let bundleGraph = event.bundleGraph;

    let outputFile = await outputFS.readFile(
      bundleGraph.getBundles()[0].filePath,
      'utf8',
    );

    let data = await get('/', port);
    assert.equal(data, outputFile);

    data = await get('/foo/bar', port);
    assert.equal(data, outputFile);
  });

  it('should serve a 404 if the file does not exist', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let statusCode = 200;
    try {
      await get('/fake.js', port);
    } catch (err) {
      statusCode = err.statusCode;
    }

    assert.equal(statusCode, 404);
  });

  it('should serve a 500 if the bundler errored', async function () {
    let port = await getPort();
    let inputDir = path.join(__dirname, '/input/server-500');
    await ncp(path.join(__dirname, '/integration/babel'), inputDir);
    let entry = path.join(inputDir, 'index.js');

    let b = bundler(entry, {
      defaultTargetOptions: {
        distDir,
      },
      inputFS: overlayFS,
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);
    await outputFS.writeFile(path.join(inputDir, 'foo.js'), 'syntax\\error');

    // Await the second build failing (which means resolving with
    // a buildFailure event)
    await getNextBuild(b);

    let statusCode = 200;
    try {
      await get('/index.js', port);
    } catch (err) {
      statusCode = err.statusCode;
      assert(err.data.includes('Expected unicode escape'));
    }

    assert.equal(statusCode, 500);
  });

  it('should support HTTPS', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: true,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/index.js', port, https);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8'),
    );
  });

  it('should support HTTPS via custom certificate', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: {
          key: path.join(__dirname, '/integration/https/private.pem'),
          cert: path.join(__dirname, '/integration/https/primary.crt'),
        },
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/index.js', port, https);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8'),
    );
  });

  it('should support setting a public url', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
        publicUrl: '/dist',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/dist/index.js', port);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8'),
    );
  });

  it('should work with query parameters that contain a dot', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/commonjs/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/index.js?foo=bar.baz', port);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8'),
    );
  });

  it('should work with paths that contain a dot', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/html/index.html'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
    });

    subscription = await b.watch();
    await getNextBuild(b);

    let data = await get('/bar.baz', port);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.html'), 'utf8'),
    );
  });

  it('should support lazy bundling', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/html/index.html'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
      shouldBuildLazily: true,
      shouldContentHash: false,
    });

    await outputFS.mkdirp(distDir);

    let builds = [];
    subscription = await b.watch((err, buildEvent) => {
      builds.push(buildEvent);
    });

    let build = await getNextBuild(b);

    invariant(build.type === 'buildSuccess');
    assertBundles(build.bundleGraph, [
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        name: 'index.html',
        assets: ['index.html'],
      },
    ]);

    // Bundle should exist in the graph, but not written to disk as it is just a placeholder
    let dir = await outputFS.readdir(distDir);
    assert.deepEqual(dir, []);

    let data = await get('/index.html', port);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.html'), 'utf8'),
    );

    assert.equal(builds.length, 2);
    build = builds[1];
    invariant(build?.type === 'buildSuccess');
    assertBundles(build.bundleGraph, [
      {
        type: 'css',
        assets: ['index.html'],
      },
      {
        // index.html
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        // foo/index.html
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        // other.html
        name: 'other.html',
        assets: ['other.html'],
      },
      {
        // foo/other.html
        name: 'other.html',
        assets: ['other.html'],
      },
      {
        type: 'svg',
        assets: ['icons.svg'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
      {
        type: 'css',
        assets: ['index.css'],
      },
    ]);

    // Sibling bundles should have been fully written to disk, but not async bundles.
    dir = await outputFS.readdir(distDir);
    assert.deepEqual(dir.length, 8);
    assert(!dir.includes('other.html'));
  });

  it('should support lazy bundling sibling css files of dynamic import', async function () {
    let port = await getPort();
    let b = bundler(path.join(__dirname, '/integration/dynamic-css/index.js'), {
      defaultTargetOptions: {
        distDir,
      },
      config,
      serveOptions: {
        https: false,
        port: port,
        host: 'localhost',
      },
      shouldBuildLazily: true,
      shouldContentHash: false,
    });

    await outputFS.mkdirp(distDir);

    let builds = [];
    subscription = await b.watch((err, buildEvent) => {
      builds.push(buildEvent);
    });

    let build = await getNextBuild(b);

    invariant(build.type === 'buildSuccess');
    assertBundles(build.bundleGraph, [
      {
        name: 'index.js',
        assets: ['index.js'],
      },
    ]);

    // Bundle should exist in the graph, but not written to disk as it is just a placeholder
    let dir = await outputFS.readdir(distDir);
    assert.deepEqual(dir, []);

    let data = await get(`/index.js`, port);
    assert.equal(
      data,
      await outputFS.readFile(path.join(distDir, 'index.js'), 'utf8'),
    );

    assert.equal(builds.length, 2);
    build = builds[1];
    invariant(build?.type === 'buildSuccess');
    assertBundles(build.bundleGraph, [
      {
        name: 'index.js',
        assets: ['cacheLoader.js', 'css-loader.js', 'index.js', 'js-loader.js'],
      },
      {name: /local\.[0-9a-f]{8}\.js/, assets: ['local.js']},
      {name: 'index.css', assets: ['index.css']},
    ]);

    // local.js should exist in the graph, but not written to disk
    dir = await outputFS.readdir(distDir);
    assert.deepEqual(
      dir.sort(),
      ['index.js', 'index.css', 'index.js.map', 'index.css.map'].sort(),
    );

    let local = build.bundleGraph
      .getBundles()
      .find(
        b => b.type === 'js' && path.basename(b.filePath).startsWith('local'),
      );
    invariant(local);
    data = await get(`/${path.basename(local.filePath)}`, port);
    assert.equal(
      data,
      await outputFS.readFile(
        path.join(distDir, path.basename(local.filePath)),
        'utf8',
      ),
    );

    assert.equal(builds.length, 3);
    build = builds[2];
    invariant(build?.type === 'buildSuccess');
    assertBundles(build.bundleGraph, [
      {
        name: 'index.js',
        assets: ['cacheLoader.js', 'css-loader.js', 'index.js', 'js-loader.js'],
      },
      {name: 'index.css', assets: ['index.css']},
      {name: /local\.[0-9a-f]{8}\.js/, assets: ['local.js']},
      {name: /local\.[0-9a-f]{8}\.css/, assets: ['local.css']},
    ]);

    dir = await outputFS.readdir(distDir);
    assert.deepEqual(dir.length, 8); // bundles + source maps

    let localCSS = build.bundleGraph
      .getBundles()
      .find(
        b => b.type === 'css' && path.basename(b.filePath).startsWith('local'),
      );
    invariant(localCSS);

    assert(data.includes(path.basename(localCSS.filePath)));
  });
});
