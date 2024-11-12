import assert from 'assert';
import path from 'path';
import {assertBundles, bundle, distDir, outputFS} from '@parcel/test-utils';

describe('webextension', function () {
  it('should resolve a full webextension bundle', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/webextension/manifest.json'),
    );
    assertBundles(b, [
      {
        name: 'tmp.aff',
        assets: ['tmp.aff'],
      },
      {
        name: 'tmp.dic',
        assets: ['tmp.dic'],
      },
      {
        name: 'messages.json',
        assets: ['messages.json'],
      },
      {
        name: 'manifest.json',
        assets: ['manifest.json'],
      },
      {
        assets: ['background.ts'],
      },
      {assets: ['a.txt']},
      {assets: ['b.txt']},
      {assets: ['foo.png']},
      {assets: ['foo-dark.png']},
      {assets: ['popup.html']},
      {assets: ['devtools.html']},
      {assets: ['content.js']},
      {assets: ['content.css']},
      {
        assets: ['ruleset_1.json'],
      },
    ]);
    assert(
      await outputFS.exists(
        path.join(distDir, '_locales', 'en_US', 'messages.json'),
      ),
    );
    const manifest = JSON.parse(
      await outputFS.readFile(
        b.getBundles().find(b => b.name == 'manifest.json').filePath,
        'utf8',
      ),
    );
    const scripts = manifest.background.scripts;
    assert.equal(scripts.length, 1);
    for (const {path: resourcePath} of manifest.declarative_net_request
      ?.rule_resources ?? []) {
      assert(await outputFS.exists(path.join(distDir, resourcePath)));
    }
    assert(
      (
        await outputFS.readFile(path.join(distDir, scripts[0]), 'utf-8')
      ).includes('Hello Parcel!'),
    );
  });

  it('should resolve the web_accessible_resources globs', async function () {
    let b = await bundle(
      path.join(
        __dirname,
        '/integration/webextension-resolve-web-accessible-resources/manifest.json',
      ),
    );
    assertBundles(b, [
      {
        name: 'manifest.json',
        assets: ['manifest.json'],
      },
      {
        assets: ['index.ts', 'esmodule-helpers.js'],
      },
      {
        assets: ['other.ts', 'esmodule-helpers.js'],
      },
      {
        assets: [
          'esmodule-helpers.js',
          'index-jsx.jsx',
          'index.js',
          'index.js',
          'react.development.js',
        ],
      },
      {assets: ['single.js', 'esmodule-helpers.js']},
    ]);
    const manifest = JSON.parse(
      await outputFS.readFile(
        b.getBundles().find(b => b.name == 'manifest.json').filePath,
        'utf8',
      ),
    );
    const war = manifest.web_accessible_resources;
    assert.equal(war.length, 4);
  });
  it('should support web extension manifest v3', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/webextension-mv3/manifest.json'),
    );
    assertBundles(b, [
      {
        name: 'manifest.json',
        assets: ['manifest.json'],
      },
      {assets: ['background.js']},
      {assets: ['background.js']},
      {assets: ['popup.html']},
      {assets: ['popup.css']},
      {assets: ['popup.js', 'esmodule-helpers.js', 'bundle-url.js']},
      {assets: ['side-panel.html']},
      {assets: ['content-script.js']},
      {assets: ['other-content-script.js']},
      {assets: ['injected.css']},
    ]);
    const manifest = JSON.parse(
      await outputFS.readFile(path.join(distDir, 'manifest.json'), 'utf-8'),
    );
    const css = manifest.content_scripts[0].css;
    assert.equal(css.length, 1);
    assert(
      (await outputFS.readFile(path.join(distDir, css[0]), 'utf-8')).includes(
        'Comic Sans MS',
      ),
    );
  });
  // TODO: Test error-checking
});
