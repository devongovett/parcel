import assert from 'assert';
import {bundle, outputFS, fsFixture, overlayFS} from '@parcel/test-utils';
import path from 'path';
import Logger from '@parcel/logger';
import {md} from '@parcel/diagnostic';

describe('svg-react', function () {
  it('should support transforming SVGs to react components', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/svg-react/react.js'),
      {
        defaultConfig: path.join(
          __dirname,
          'integration/custom-configs/.parcelrc-svg-react',
        ),
      },
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf-8');
    assert(!file.includes('inkscape'));
    assert(file.includes('const SvgIcon ='));
    assert(file.includes('_react.createElement("svg"'));
  });

  it('should support transforming SVGs to typescript react components', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/svg-react-typescript/react.ts'),
      {
        defaultConfig: path.join(
          __dirname,
          'integration/custom-configs/.parcelrc-svg-react',
        ),
      },
    );
    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf-8');
    let types = await outputFS.readFile(b.getBundles()[1].filePath, 'utf-8');

    assert(!file.includes('inkscape'));
    assert(file.includes('react.createElement("svg"'));
    assert(types.includes('const Icon: SVGRComponent'));
  });

  it('should find and use a .svgrrc and .svgorc config file', async function () {
    let b = await bundle(
      path.join(__dirname, '/integration/svg-react-config/react.js'),
      {
        defaultConfig: path.join(
          __dirname,
          'integration/custom-configs/.parcelrc-svg-react',
        ),
      },
    );

    let file = await outputFS.readFile(b.getBundles()[0].filePath, 'utf-8');
    assert(!file.includes('inkscape'));
    assert(!/\d\.\d/.test(file));
    assert(file.includes('const SvgIcon ='));
    assert(file.includes('(0, _preact.h)("svg"'));
    assert(file.includes('width: "1em"'));
  });

  it('should detect the version of SVGO to use', async function () {
    // Test is outside parcel so that svgo is not already installed.
    await fsFixture(overlayFS, '/')`
      svgr-svgo-version
        icon.svg:
          <svg></svg>

        index.html:
          <img src="icon.svg" />

        svgo.config.json:
          {
            "full": true
          }

        yarn.lock:
    `;

    let messages = [];
    let loggerDisposable = Logger.onLog(message => {
      if (message.level !== 'verbose') {
        messages.push(message);
      }
    });

    try {
      await bundle(path.join('/svgr-svgo-version/index.html'), {
        inputFS: overlayFS,
        defaultTargetOptions: {
          shouldOptimize: true,
        },
        shouldAutoinstall: false,
        defaultConfig: path.join(
          __dirname,
          'integration/custom-configs/.parcelrc-svg-react',
        ),
      });
    } catch (err) {
      // autoinstall is disabled
      assert.equal(
        err.diagnostics[0].message,
        md`Could not resolve module "svgo" from "${path.resolve(
          overlayFS.cwd(),
          '/svgr-svgo-version/index',
        )}"`,
      );
    }

    loggerDisposable.dispose();
    assert(
      messages[0].diagnostics[0].message.startsWith(
        'Detected deprecated SVGO v2 options in',
      ),
    );
    assert.deepEqual(messages[0].diagnostics[0].codeFrames, [
      {
        filePath: path.resolve(
          overlayFS.cwd(),
          '/svgr-svgo-version/svgo.config.json',
        ),
        codeHighlights: [
          {
            message: undefined,
            start: {
              line: 2,
              column: 3,
            },
            end: {
              line: 2,
              column: 14,
            },
          },
        ],
      },
    ]);
  });
});
