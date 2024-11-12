import assert from 'assert';
import path from 'path';
import {assertBundles, bundle, outputFS, distDir} from '@parcel/test-utils';

describe('pug', function () {
  it('should support bundling HTML', async function () {
    const b = await bundle(path.join(__dirname, '/integration/pug/index.pug'));

    assertBundles(b, [
      {
        type: 'html',
        name: 'index.html',
        assets: ['index.pug'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
      {
        type: 'svg',
        assets: ['icons.svg'],
      },
      {
        type: 'css',
        assets: ['index.css'],
      },
      {
        type: 'js',
        assets: ['index.js'],
      },
    ]);

    const files = await outputFS.readdir(distDir);
    const html = await outputFS.readFile(path.join(distDir, 'index.html'));
    for (let file of files) {
      const ext = file.match(/\.([0-9a-z]+)(?:[?#]|$)/i)[0];
      if (file !== 'index.html' && ext !== '.map') {
        assert(html.includes(file));
      }
    }
  });

  it('should support include and extends files, connect files', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/pug-include-extends/index.pug'),
    );

    assertBundles(b, [
      {
        type: 'html',
        name: 'index.html',
        assets: ['index.pug'],
      },
    ]);

    const html = await outputFS.readFile(path.join(distDir, 'index.html'));

    assert(html.includes('<!DOCTYPE html>'));
    assert(html.includes("<h1>Yep, it's working!</h1>"));
    assert(html.includes('<p>And for nested.</p>'));
  });

  it('should support variables', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/pug-var/index.pug'),
    );

    assertBundles(b, [
      {
        type: 'html',
        name: 'index.html',
        assets: ['index.pug'],
      },
      {
        type: 'png',
        assets: ['100x100.png'],
      },
    ]);

    const html = await outputFS.readFile(path.join(distDir, 'index.html'));
    assert(/src="\/?100x100.*.png"/.test(html));
  });

  it('should support mixins', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/pug-mixins/index.pug'),
    );

    assertBundles(b, [
      {
        type: 'html',
        name: 'index.html',
        assets: ['index.pug'],
      },
    ]);

    const html = await outputFS.readFile(path.join(distDir, 'index.html'));
    assert(html.includes('Greetings, Parcel'));
  });

  it('should support filters', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/pug-filters/index.pug'),
    );

    assertBundles(b, [
      {
        type: 'html',
        name: 'index.html',
        assets: ['index.pug'],
      },
    ]);

    const html = await outputFS.readFile(path.join(distDir, 'index.html'));
    assert(html.includes('FILTERED: Hello!'));
  });

  it('should support locals with config file', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/pug-locals/index.pug'),
    );

    assertBundles(b, [
      {
        type: 'html',
        name: 'index.html',
        assets: ['index.pug'],
      },
    ]);

    const html = await outputFS.readFile(path.join(distDir, 'index.html'));
    assert(html.includes("It's a great!"));
  });

  it('should minify HTML in production mode', async function () {
    const b = await bundle(
      path.join(__dirname, '/integration/pug-minify/index.pug'),
    );

    assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.pug'],
      },
    ]);

    const html = await outputFS.readFile(path.join(distDir, 'index.html'));
    assert(html.includes('Minified'));
  });
});
