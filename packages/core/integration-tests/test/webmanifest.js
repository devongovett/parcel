import assert from 'assert';
import path from 'path';
import {assertBundles, bundle, inputFS, outputFS} from '@parcel/test-utils';
import {md} from '@parcel/diagnostic';

describe('webmanifest', function () {
  it('should support .webmanifest', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/webmanifest/index.html'),
    );

    await assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        name: 'manifest.webmanifest',
        assets: ['manifest.webmanifest'],
      },
      {
        type: 'png',
        assets: ['icon.png'],
      },
      {
        type: 'png',
        assets: ['screenshot.png'],
      },
      {
        type: 'png',
        assets: ['shortcut-icon.png'],
      },
      {
        type: 'png',
        assets: ['file-handler-icon.png'],
      },
    ]);

    const manifest = await outputFS.readFile(
      b.getBundles().find(b => b.type === 'webmanifest').filePath,
      'utf8',
    );
    assert(/screenshot\.[0-9a-f]+\.png/.test(manifest));
    assert(/icon\.[0-9a-f]+\.png/.test(manifest));
    assert(/shortcut-icon\.[0-9a-f]+\.png/.test(manifest));
    assert(/file-handler-icon\.[0-9a-f]+\.png/.test(manifest));
  });

  it('should support .json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/webmanifest-json/index.html'),
    );

    await assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        name: 'manifest.webmanifest',
        assets: ['manifest.json'],
      },
      {
        type: 'png',
        assets: ['icon.png'],
      },
      {
        type: 'png',
        assets: ['screenshot.png'],
      },
      {
        type: 'png',
        assets: ['shortcut-icon.png'],
      },
      {
        type: 'png',
        assets: ['file-handler-icon.png'],
      },
    ]);

    const manifest = await outputFS.readFile(
      b.getBundles().find(b => b.type === 'webmanifest').filePath,
      'utf8',
    );
    assert(/screenshot\.[0-9a-f]+\.png/.test(manifest));
    assert(/icon\.[0-9a-f]+\.png/.test(manifest));
    assert(/shortcut-icon\.[0-9a-f]+\.png/.test(manifest));
    assert(/file-handler-icon\.[0-9a-f]+\.png/.test(manifest));
  });

  it('should throw on malformed icons, screenshots, shortcuts, and file handlers', async function () {
    let manifestPath = path.join(
      __dirname,
      '/integration/webmanifest-schema/manifest.webmanifest',
    );
    let manifest = await inputFS.readFileSync(manifestPath, 'utf8');

    await assert.rejects(
      () =>
        bundle(
          path.join(__dirname, '/integration/webmanifest-schema/index.html'),
        ),
      {
        name: 'BuildError',
        message: path.normalize('Invalid webmanifest'),
        diagnostics: [
          {
            codeFrames: [
              {
                filePath: manifestPath,
                language: 'json',
                code: manifest,
                codeHighlights: [
                  {
                    end: {
                      column: 5,
                      line: 12,
                    },
                    message: 'Missing property src',
                    start: {
                      column: 5,
                      line: 9,
                    },
                  },
                  {
                    end: {
                      column: 6,
                      line: 13,
                    },
                    message: 'Missing property src',
                    start: {
                      column: 5,
                      line: 13,
                    },
                  },
                  {
                    end: {
                      column: 19,
                      line: 15,
                    },
                    message: 'Expected type array',
                    start: {
                      column: 18,
                      line: 15,
                    },
                  },
                  {
                    end: {
                      column: 17,
                      line: 18,
                    },
                    message: 'Expected type array',
                    start: {
                      column: 16,
                      line: 18,
                    },
                  },
                  {
                    end: {
                      column: 9,
                      line: 30,
                    },
                    message: 'Missing property src',
                    start: {
                      column: 9,
                      line: 27,
                    },
                  },
                  {
                    end: {
                      column: 10,
                      line: 31,
                    },
                    message: 'Missing property src',
                    start: {
                      column: 9,
                      line: 31,
                    },
                  },
                  {
                    end: {
                      column: 21,
                      line: 35,
                    },
                    message: 'Expected type array',
                    start: {
                      column: 20,
                      line: 35,
                    },
                  },
                ],
              },
            ],
            message: 'Invalid webmanifest',
            origin: '@parcel/transformer-webmanifest',
          },
        ],
      },
    );
  });

  it('should throw on missing dependency', async function () {
    let manifestPathRelative =
      './integration/webmanifest-not-found/manifest.webmanifest';
    let manifestPath = path.join(__dirname, manifestPathRelative);
    let manifest = await inputFS.readFileSync(manifestPath, 'utf8');

    let message = md`Failed to resolve 'icon.png' from '${manifestPathRelative}'`;

    await assert.rejects(
      () =>
        bundle(
          path.join(__dirname, '/integration/webmanifest-not-found/index.html'),
        ),
      {
        name: 'BuildError',
        message,
        diagnostics: [
          {
            codeFrames: [
              {
                filePath: manifestPath,
                code: manifest,
                codeHighlights: [
                  {
                    message: undefined,
                    end: {
                      column: 23,
                      line: 5,
                    },
                    start: {
                      column: 14,
                      line: 5,
                    },
                  },
                ],
              },
            ],
            message,
            origin: '@parcel/core',
          },
          {
            hints: [],
            message: `Cannot load file './icon.png' in '${path.dirname(
              manifestPathRelative,
            )}'.`,
            origin: '@parcel/resolver-default',
          },
        ],
      },
    );
  });

  it('should work when there is a target in package.json', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/webmanifest-targets/index.html'),
    );

    await assertBundles(b, [
      {
        name: 'index.html',
        assets: ['index.html'],
      },
      {
        name: 'manifest.webmanifest',
        assets: ['manifest.json'],
      },
    ]);
  });
});
