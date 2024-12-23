// @flow
import assert from 'assert';
import path from 'path';
import {bundle, overlayFS, fsFixture, assertBundles} from '@parcel/test-utils';

describe('react static', function () {
  let count = 0;
  let dir;
  beforeEach(async () => {
    dir = path.join(__dirname, 'react-static', '' + ++count);
    await overlayFS.mkdirp(dir);
    await overlayFS.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'react-static-test',
        dependencies: {
          react: '^19',
        },
        targets: {
          default: {
            context: 'react-server',
            scopeHoist: false,
          },
        },
      }),
    );

    await overlayFS.writeFile(
      path.join(dir, '.parcelrc'),
      JSON.stringify({
        extends: '@parcel/config-react-static',
      }),
    );

    await overlayFS.writeFile(path.join(dir, 'yarn.lock'), '');
  });

  after(async () => {
    await overlayFS.rimraf(path.join(__dirname, 'react-static'));
  });

  it('should render to HTML', async function () {
    await fsFixture(overlayFS, dir)`
    index.jsx:
      import {Client} from './client';
      import {Resources} from "@parcel/runtime-rsc";
      import './bootstrap';

      export default function Index() {
        return (
          <html>
            <head>
              <title>Static RSC</title>
              <Resources />
            </head>
            <body>
              <h1>This is an RSC!</h1>
              <Client />
            </body>
          </html>
        );
      }

    client.jsx:
      "use client";
      export function Client() {
        return <p>Client</p>;
      }

    bootstrap.js:
      "use client-entry";
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
      mode: 'production',
      env: {
        NODE_ENV: 'production',
      },
    });

    assertBundles(
      b,
      [
        {
          name: 'index.html',
          assets: ['index.jsx', 'resources.js'],
        },
        {
          assets: ['client.jsx', 'bootstrap.js'],
        },
      ],
      {skipNodeModules: true},
    );

    let files = b.getBundles()[0].files;
    assert.equal(files.length, 2);
    assert.equal(path.basename(files[0].filePath), 'index.html');
    assert.equal(path.basename(files[1].filePath), 'index.rsc');

    let output = await overlayFS.readFile(files[0].filePath, 'utf8');
    assert(output.includes('<h1>This is an RSC!</h1><p>Client</p>'));
    assert(output.includes('<script type="module">import '));

    let rsc = await overlayFS.readFile(files[1].filePath, 'utf8');
    assert(rsc.includes('{"children":"This is an RSC!"}'));
  });

  it('should render a list of pages', async function () {
    await fsFixture(overlayFS, dir)`
    index.jsx:
      import {Nav} from './Nav';
      export default function Index(props) {
        return (
          <html>
            <body>
              <h1>Home</h1>
              <Nav {...props} />
            </body>
          </html>
        );
      }

    other.jsx:
      import {Nav} from './Nav';
      export default function Other(props) {
        return (
          <html>
            <body>
              <h1>Other</h1>
              <Nav {...props} />
            </body>
          </html>
        );
      }

    Nav.jsx:
      export function Nav({pages, currentPage}) {
        return (
          <nav>
            <ul>
              {pages.map(page => (
                <li key={page.url}>
                  <a href={page.url} aria-current={page.url === currentPage.url ? 'page' : undefined}>
                    {page.name.replace('.html', '')}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        );
      }
    `;

    let b = await bundle(
      [path.join(dir, '/index.jsx'), path.join(dir, '/other.jsx')],
      {
        inputFS: overlayFS,
        targets: ['default'],
      },
    );

    assertBundles(
      b,
      [
        {
          name: 'index.html',
          assets: ['index.jsx', 'Nav.jsx'],
        },
        {
          name: 'other.html',
          assets: ['other.jsx', 'Nav.jsx'],
        },
      ],
      {skipNodeModules: true},
    );

    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(
      output.includes(
        '<h1>Home</h1><nav><ul><li><a href="/index.html" aria-current="page">index</a></li><li><a href="/other.html">other</a></li></ul></nav>',
      ),
    );

    output = await overlayFS.readFile(b.getBundles()[1].filePath, 'utf8');
    assert(
      output.includes(
        '<h1>Other</h1><nav><ul><li><a href="/index.html">index</a></li><li><a href="/other.html" aria-current="page">other</a></li></ul></nav>',
      ),
    );
  });
});
