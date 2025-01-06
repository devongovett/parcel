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
      import './bootstrap';

      export default function Index() {
        return (
          <html>
            <head>
              <title>Static RSC</title>
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
          assets: ['index.jsx'],
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
    assert(output.includes('<script>Promise.all('));

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

  it('should support MDX', async function () {
    await fsFixture(overlayFS, dir)`
    index.mdx:
      import {Layout} from './Layout';
      export default Layout;

      export const title = 'Home';

      # Testing

      Hello this is a test.

      ## Sub title

      Yo.

    another.mdx:
      import {Layout} from './Layout';
      export default Layout;

      # Another page

      Hello this is a test.

    Layout.jsx:
      function Toc({toc}) {
        return toc?.length ? <ul>{toc.map((t, i) => <li key={i}>{t.title}<Toc toc={t.children} /></li>)}</ul> : null;
      }

      export function Layout({children, pages, currentPage}) {
        return (
          <html>
            <head>
              <title>{currentPage.meta.exports.title ?? currentPage.meta.tableOfContents?.[0].title}</title>
            </head>
            <body>
              <nav>
                {pages.map(page => <a key={page.url} href={page.url}>
                  {page.meta.exports.title ?? page.meta.tableOfContents?.[0].title}
                </a>)}
              </nav>
              <aside>
                <Toc toc={currentPage.meta.tableOfContents} />
              </aside>
              <main>
                {children}
              </main>
            </body>
          </html>
        )
      }
    `;

    let b = await bundle(path.join(dir, '/*.mdx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<title>Home</title>'));
    assert(
      output.includes(
        '<a href="/index.html">Home</a><a href="/another.html">Another page</a>',
      ),
    );
    assert(
      output.includes('<ul><li>Testing<ul><li>Sub title</li></ul></li></ul>'),
    );

    output = await overlayFS.readFile(b.getBundles()[1].filePath, 'utf8');
    assert(output.includes('<title>Another page</title>'));
    assert(
      output.includes(
        '<a href="/index.html">Home</a><a href="/another.html">Another page</a>',
      ),
    );
    assert(output.includes('<ul><li>Another page</li></ul>'));
  });

  it('should support dynamic importing a server component from a server component', async function () {
    await fsFixture(overlayFS, dir)`
      index.jsx:
        export default async function Index() {
          let {Server} = await import('./server');
          return (
            <html>
              <body>
                <Server />
              </body>
            </html>
          );
        }

      server.jsx:
        import './server.css';
        export function Server() {
          return <h1>Server</h1>;
        }

      server.css:
        h1 { color: red }
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<link rel="stylesheet"'));
  });

  it('should support dynamic importing a client component from a server component', async function () {
    await fsFixture(overlayFS, dir)`
      index.jsx:
        export default async function Index() {
          let {Client} = await import('./client');
          return (
            <html>
              <body>
                <Client />
              </body>
            </html>
          );
        }

      client.jsx:
        "use client";
        import './client.css';
        export function Client() {
          return <h1>Client</h1>;
        }

      client.css:
        h1 { color: red }
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    // CSS is injected via JSX. Scripts are injected by React's prepareDestinationForModule.
    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<link rel="stylesheet"'));
    assert(output.includes('<script '));
  });

  it('should support dynamic importing a client component from a server component with React.lazy', async function () {
    await fsFixture(overlayFS, dir)`
      index.jsx:
        import {lazy} from 'react';
        const Client = lazy(() => import('./client'));
        export default async function Index() {
          return (
            <html>
              <body>
                <Client />
              </body>
            </html>
          );
        }

      client.jsx:
        "use client";
        import './client.css';
        export default function Client() {
          return <h1>Client</h1>;
        }

      client.css:
        h1 { color: red }
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    // CSS is injected via JSX. Scripts are injected by React's prepareDestinationForModule.
    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<link rel="stylesheet"'));
    assert(output.includes('<script '));
  });

  it('should support dynamic importing a client component from a client component', async function () {
    await fsFixture(overlayFS, dir)`
      index.jsx:
        import {Client} from './client';
        export default async function Index() {
          return (
            <html>
              <body>
                <Client />
              </body>
            </html>
          );
        }

      client.jsx:
        "use client";
        import {lazy} from 'react';
        const Dynamic = lazy(() => import('./dynamic'));
        export function Client() {
          return <Dynamic />;
        }
          
      dynamic.jsx:
        import './client.css';
        export default function Dynamic() {
          return <h1>Dynamic</h1>
        }

      client.css:
        h1 { color: red }
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<link rel="stylesheet"'));
    assert(output.includes('<script type="module"'));
  });

  it('should support dynamic importing an object with components attached', async function () {
    await fsFixture(overlayFS, dir)`
      index.jsx:
        export default async function Index() {
          let {default: components} = await import('./server');
          return (
            <html>
              <body>
                <components.Server />
              </body>
            </html>
          );
        }

      server.jsx:
        import './server.css';
        function Server() {
          return <h1>Server</h1>;
        }
        export default {Server};

      server.css:
        h1 { color: red }
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<link rel="stylesheet"'));
  });

  it('should support dynamic importing a React.memo component', async function () {
    await fsFixture(overlayFS, dir)`
      index.jsx:
        export default async function Index() {
          let {default: Server} = await import('./server');
          return (
            <html>
              <body>
                <Server />
              </body>
            </html>
          );
        }

      server.jsx:
        import './server.css';
        import {memo} from 'react';
        export default memo(function Server() {
          return <h1>Server</h1>;
        });

      server.css:
        h1 { color: red }
    `;

    let b = await bundle(path.join(dir, '/index.jsx'), {
      inputFS: overlayFS,
      targets: ['default'],
    });

    let output = await overlayFS.readFile(b.getBundles()[0].filePath, 'utf8');
    assert(output.includes('<link rel="stylesheet"'));
  });
});
