// @flow
import assert from 'assert';
import path from 'path';
import {
  bundle,
  run,
  overlayFS,
  fsFixture,
  assertBundles,
  runBundle,
} from '@parcel/test-utils';
import nullthrows from 'nullthrows';

describe('react server components', function () {
  for (let shouldScopeHoist of [false, true]) {
    describe(
      shouldScopeHoist ? 'with scope hoisting' : 'without scope hoisting',
      function () {
        let count = 0;
        let dir;
        beforeEach(async () => {
          dir = path.join(__dirname, 'react-server', '' + ++count);
          await overlayFS.mkdirp(dir);
          await overlayFS.writeFile(
            path.join(dir, 'package.json'),
            JSON.stringify({
              name: 'react-server-test',
              dependencies: {
                react: '^19',
              },
              targets: {
                default: {
                  context: 'react-server',
                  outputFormat: 'commonjs',
                },
              },
              '@parcel/resolver-default': {
                packageExports: true,
              },
              '@parcel/bundler-default': {
                minBundleSize: 0,
              },
            }),
          );

          await overlayFS.writeFile(path.join(dir, 'yarn.lock'), '');
        });

        after(async () => {
          await overlayFS.rimraf(path.join(__dirname, 'react-server'));
        });

        it('should support client references', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {Client} from './client';
            function Server() {
              return <Client />;
            }
            output = {Server};

          client.jsx:
            "use client";
            export function Client() {
              return <p>Client</p>;
            }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          let bundles = b.getBundles();
          assert.equal(bundles.length, 2);
          assert.equal(bundles[0].env.context, 'react-server');
          assert.equal(bundles[1].env.context, 'react-client');
          assertBundles(
            b,
            [
              {
                assets: ['index.jsx'],
              },
              {
                assets: ['client.jsx'],
              },
            ],
            {skipNodeModules: true},
          );

          let res = (await run(b, null, {require: false})).output;
          let result = res.Server();
          assert.equal(
            result.type.$$typeof,
            Symbol.for('react.client.reference'),
          );
          assert.equal(result.type.$$name, 'Client');
          assert.equal(typeof result.type.$$id, 'string');
          assert.deepEqual(result.type.$$bundles, [
            path.basename(bundles[1].filePath),
          ]);
        });

        it('should support CSS imports in server and client components', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {Client} from './client';
            import './server.css';
            function Server() {
              return <Client />;
            }
            output = {Server};

          client.jsx:
            "use client";
            import './client.css';
            export function Client() {
              return <p>Client</p>;
            }

          server.css:
            .foo { color: red }

          client.css:
            .bar { background: pink }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          let bundles = b.getBundles();
          assert.equal(bundles.length, 3);
          assert.equal(bundles[0].env.context, 'react-server');
          assert.equal(bundles[1].env.context, 'react-client');
          assert.equal(bundles[2].env.context, 'browser');
        });

        it('should support server references from client components', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {Client} from './client';
            import {loadServerAction} from 'react-server-dom-parcel/server.edge';
            function Server() {
              return <Client />;
            }

            async function runAction(id, args) {
              let action = await loadServerAction(id);
              return action(...args);
            }
            output = {Server, runAction};

          client.jsx:
            "use client";
            import {setServerCallback} from 'react-server-dom-parcel/client';
            import {action} from './actions';
            export function Client() {
              return <p>Client</p>;
            }

            export function callAction() {
              action(2);
            }

            setServerCallback(async function (id, args) {
              callback(id, args);
            });
            
            output = {callAction};

          actions.js:
            "use server";
            export function action(arg) {
              return arg + 1;
            }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          let bundles = b.getBundles();
          assert.equal(bundles.length, 2);
          assert.equal(bundles[0].env.context, 'react-server');
          assert.equal(bundles[1].env.context, 'react-client');
          assertBundles(
            b,
            [
              {
                assets: ['index.jsx', 'actions.js'],
              },
              {
                assets: ['client.jsx'],
              },
            ],
            {skipNodeModules: true},
          );

          let entryAsset;
          b.getBundles()[1].traverseAssets(a => {
            if (a.filePath.endsWith('client.jsx')) {
              entryAsset = a;
            }
          });
          let id, args;
          let callback = (a, b) => {
            id = a;
            args = b;
          };
          let client = (await runBundle(
            b,
            b.getBundles()[1],
            {callback, output: null},
            {require: false, entryAsset},
          ): any);
          let parcelRequire = nullthrows(
            Object.keys(client).find(k => k.startsWith('parcelRequire')),
          );
          client[parcelRequire](b.getAssetPublicId(nullthrows(entryAsset)));
          client.output.callAction();
          assert.equal(typeof id, 'string');
          assert.deepEqual(args, [2]);

          let server = (await runBundle(b, b.getBundles()[0], null, {
            require: false,
          }): any).output;
          let result = await server.runAction(id, args);
          assert.equal(result, 3);
        });

        it('should support passing server references to the client', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {Client} from './client';
            import {action} from './actions';
            import {loadServerAction} from 'react-server-dom-parcel/server.edge';
            function Server() {
              return <Client action={action} />;
            }

            function callActionDirectly() {
              return action(2);
            }

            async function runAction(id, args) {
              let action = await loadServerAction(id);
              return action(...args);
            }
            output = {Server, callActionDirectly, runAction};

          client.jsx:
            "use client";
            export function Client() {
              return <p>Client</p>;
            }

          actions.js:
            "use server";
            export function action(arg) {
              return arg + 1;
            }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          let bundles = b.getBundles();
          assert.equal(bundles.length, 2);
          assert.equal(bundles[0].env.context, 'react-server');
          assert.equal(bundles[1].env.context, 'react-client');
          assertBundles(
            b,
            [
              {
                assets: ['index.jsx', 'actions.js'],
              },
              {
                assets: ['client.jsx'],
              },
            ],
            {skipNodeModules: true},
          );

          let res = (await run(b, null, {require: false})).output;
          let result = res.Server();
          assert.equal(
            result.type.$$typeof,
            Symbol.for('react.client.reference'),
          );
          assert.equal(typeof result.props.action, 'function');
          assert.equal(
            result.props.action.$$typeof,
            Symbol.for('react.server.reference'),
          );
          assert.equal(typeof result.props.action.$$id, 'string');

          let x = await res.runAction(result.props.action.$$id, [5]);
          assert.equal(x, 6);

          let v = res.callActionDirectly();
          assert.equal(v, 3);
        });

        it('should support "use server-entry"', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {use} from 'react' with {env: 'react-client'};
            import {Server} from './App.jsx';
            function render() {
              use(stuff);
              return <Server />;
            }
            output = {render};

          App.jsx:
            "use server-entry";
            import {Client} from './client';
            export function Server() {
              return <Client />;
            }
  
          client.jsx:
            "use client";
            import {useState} from 'react';
            export function Client() {
              useState();
              return <p>Client</p>;
            }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          assertBundles(
            b,
            [
              {
                assets: [
                  'index.jsx',
                  'jsx-dev-runtime.react-server.js',
                  'react-jsx-dev-runtime.react-server.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                ],
              },
              {
                assets: [
                  'App.jsx',
                  'jsx-dev-runtime.react-server.js',
                  'react-dom.react-server.development.js',
                  'react-dom.react-server.js',
                  'react-jsx-dev-runtime.react-server.development.js',
                  'react-server-dom-parcel-server.edge.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                  'server.edge.js',
                ],
              },
              {
                assets: [
                  'client.jsx',
                  'react-jsx-dev-runtime.development.js',
                  'index.js',
                  'jsx-dev-runtime.js',
                  'react.development.js',
                ],
              },
              {
                assets: ['index.js', 'react.development.js'],
              },
            ],
            {skipHelpers: true},
          );
        });

        it('should share react between pages', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {Page1} from './Page1.jsx';
            import {Page2} from './Page2.jsx';
            function render() {
              return <Page1 /> || <Page2 />;
            }
            output = {render};

          Page1.jsx:
            "use server-entry";
            import {Client} from './client';
            export function Server() {
              return <Client />;
            }

          Page2.jsx:
            "use server-entry";
            import {Client} from './client';
            export function Server() {
              return <Client />;
            }
  
          client.jsx:
            "use client";
            import {useState} from 'react';
            export function Client() {
              useState();
              return <p>Client</p>;
            }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          assertBundles(
            b,
            [
              {
                // Server: entry
                assets: [
                  'index.jsx',
                  'jsx-dev-runtime.react-server.js',
                  'react-jsx-dev-runtime.react-server.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                ],
              },
              {
                // Server: Page 1
                assets: [
                  'Page1.jsx',
                  'react-dom.react-server.development.js',
                  'react-dom.react-server.js',
                  'react-server-dom-parcel-server.edge.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                  'server.edge.js',
                ],
              },
              {
                // Server: Page 2
                assets: [
                  'Page2.jsx',
                  'react-dom.react-server.development.js',
                  'react-dom.react-server.js',
                  'react-server-dom-parcel-server.edge.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                  'server.edge.js',
                ],
              },
              {
                // Server: shared assets between pages.
                assets: [
                  'jsx-dev-runtime.react-server.js',
                  'react-jsx-dev-runtime.react-server.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                ],
              },
              {
                // Client: component.
                assets: [
                  'client.jsx',
                  'index.js',
                  'jsx-dev-runtime.js',
                  'react-jsx-dev-runtime.development.js',
                  'react.development.js',
                ],
              },
            ],
            {skipHelpers: true},
          );
        });

        it('should share react between pages when server entry uses env import attribute', async function () {
          await fsFixture(overlayFS, dir)`
          index.jsx:
            import {use} from 'react' with {env: 'react-client'};
            import {Page1} from './Page1.jsx';
            import {Page2} from './Page2.jsx';
            function render() {
              use(stuff);
              return <Page1 /> || <Page2 />;
            }
            output = {render};

          Page1.jsx:
            "use server-entry";
            import {Client1} from './Client1';
            export function Server() {
              return <Client1 />;
            }

          Page2.jsx:
            "use server-entry";
            import {Client2} from './Client2';
            export function Server() {
              return <Client2 />;
            }
  
          Client1.jsx:
            "use client";
            import {useState} from 'react';
            export function Client1() {
              useState();
              return <p>Client 1</p>;
            }

          Client2.jsx:
            "use client";
            import {useState} from 'react';
            export function Client2() {
              useState();
              return <p>Client 2</p>;
            }
        `;

          let b = await bundle(path.join(dir, '/index.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          assertBundles(
            b,
            [
              {
                // Server: entry
                assets: [
                  'index.jsx',
                  'jsx-dev-runtime.react-server.js',
                  'react-jsx-dev-runtime.react-server.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                ],
              },
              {
                // Client dependencies for server
                assets: ['index.js', 'react.development.js'],
              },
              {
                // Server: Page 1
                assets: [
                  'Page1.jsx',
                  'react-dom.react-server.development.js',
                  'react-dom.react-server.js',
                  'react-server-dom-parcel-server.edge.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                  'server.edge.js',
                ],
              },
              {
                // Server: Page 2
                assets: [
                  'Page2.jsx',
                  'react-dom.react-server.development.js',
                  'react-dom.react-server.js',
                  'react-server-dom-parcel-server.edge.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                  'server.edge.js',
                ],
              },
              {
                // Server: shared assets between pages.
                assets: [
                  'jsx-dev-runtime.react-server.js',
                  'react-jsx-dev-runtime.react-server.development.js',
                  'react.react-server.development.js',
                  'react.react-server.js',
                ],
              },
              {
                // Client: component.
                assets: ['Client1.jsx'],
              },
              {
                // Client: component.
                assets: ['Client2.jsx'],
              },
              {
                // Client: shared bundle.
                assets: [
                  'index.js',
                  'jsx-dev-runtime.js',
                  'react-jsx-dev-runtime.development.js',
                  'react.development.js',
                ],
              },
            ],
            {skipHelpers: true},
          );
        });

        it('should support <Resources>', async function () {
          await fsFixture(overlayFS, dir)`
          Page.jsx:
            import {Client} from './Client';
            import {Resources} from '@parcel/runtime-rsc';
            import './server.css';
            export function Server() {
              return <><Resources /><Client /></>;
            }
            output = {Resources};

          server.css:
            .server { color: red }

          Client.jsx:
            "use client";
            import './client.css';
            export function Client() {
              return <p>Client</p>;
            }

          client.css:
            .client { color: green }
        `;

          let b = await bundle(path.join(dir, '/Page.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          assertBundles(
            b,
            [
              {
                assets: ['Page.jsx', 'resources.js'],
              },
              {
                assets: ['Client.jsx'],
              },
              {
                assets: ['server.css', 'client.css'],
              },
            ],
            {skipNodeModules: true},
          );

          let res = (await run(b, null, {require: false})).output;
          let resources = res.Resources();

          let link = resources.props.children;
          assert.equal(link.type, 'link');
          assert.equal(link.props.rel, 'stylesheet');
          assert.equal(link.props.precedence, 'default');
          assert.equal(
            link.props.href,
            '/' +
              path.basename(
                nullthrows(b.getBundles().find(b => b.type === 'css')).filePath,
              ),
          );
        });

        it('should generate an inline script for bootstrap with "use client-entry"', async function () {
          await fsFixture(overlayFS, dir)`
          Page.jsx:
            import {Client} from './Client';
            import {Resources} from '@parcel/runtime-rsc';
            import './client-entry.jsx';
            export function Server() {
              return <><Resources /><Client /></>;
            }
            output = {Resources};

          client-entry.jsx:
            "use client-entry";
            console.log('do stuff');

          Client.jsx:
            "use client";
            export function Client() {
              return <p>Client</p>;
            }
        `;

          let b = await bundle(path.join(dir, '/Page.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          assertBundles(
            b,
            [
              {
                assets: ['Page.jsx', 'resources.js'],
              },
              {
                assets: ['client-entry.jsx', 'Client.jsx'],
              },
            ],
            {skipNodeModules: true},
          );

          let res = await run(b, null, {require: false});
          let resources = res.output.Resources();
          let parcelRequireName = nullthrows(
            Object.keys(res).find(k => /^parcelRequire(.+)$/.test(k)),
          );
          let clientEntry;
          b.getBundles()[1].traverseAssets(a => {
            if (
              Array.isArray(a.meta.directives) &&
              a.meta.directives.includes('use client-entry')
            ) {
              clientEntry = a;
            }
          });

          let script = resources.props.children;
          assert.equal(script.type, 'script');
          assert.equal(script.props.type, 'module');
          assert.equal(
            script.props.children,
            `import "/${path.basename(
              b.getBundles()[1].filePath,
            )}";${parcelRequireName}("${b.getAssetPublicId(
              nullthrows(clientEntry),
            )}")`,
          );
        });

        it('dynamic import works with client components', async function () {
          await fsFixture(overlayFS, dir)`
          Page.jsx:
            import {Resources} from '@parcel/runtime-rsc/resources';
            import './server.css';
            export async function Server() {
              let {Client} = await import('./Client');
              return [<Resources />, <Client />];
            }
            output = {Server, Resources};

          server.css:
            .server { color: red }
  
          Client.jsx:
            "use client";
            import {Resources} from '@parcel/runtime-rsc/resources';
            import './client.css';
            export function Client() {
              return <p><Resources />Client</p>;
            }
            output = {Resources};

          client.css:
            .client { color: green }
        `;

          let b = await bundle(path.join(dir, '/Page.jsx'), {
            inputFS: overlayFS,
            targets: ['default'],
            defaultTargetOptions: {
              shouldScopeHoist,
            },
          });

          assertBundles(
            b,
            [
              {
                assets: ['Page.jsx', 'resources.js'],
              },
              {
                assets: ['Client.jsx', 'resources.js'],
              },
              {
                assets: ['server.css'],
              },
              {
                assets: ['client.css'],
              },
            ],
            {skipNodeModules: true},
          );

          let res = (await run(b, null, {require: false})).output;
          let result = await res.Server();
          assert.equal(
            result[1].type.$$typeof,
            Symbol.for('react.client.reference'),
          );
          assert.equal(result[1].type.$$name, 'Client');
          assert.equal(typeof result[1].type.$$id, 'string');
          assert.deepEqual(result[1].type.$$bundles, [
            path.basename(b.getBundles()[1].filePath),
          ]);

          let resources = res.Resources();
          let link = resources.props.children;
          assert.equal(link.type, 'link');
          assert.equal(link.props.rel, 'stylesheet');
          assert.equal(link.props.precedence, 'default');
          assert.equal(
            link.props.href,
            '/' +
              path.basename(
                nullthrows(
                  b
                    .getBundles()
                    .find(b => b.type === 'css' && b.name.startsWith('Page')),
                ).filePath,
              ),
          );

          let entryAsset;
          b.getBundles()[1].traverseAssets(a => {
            if (a.filePath.endsWith('Client.jsx')) {
              entryAsset = a;
            }
          });

          let client = (await runBundle(
            b,
            b.getBundles()[1],
            {output: null},
            {require: false, entryAsset},
          ): any);
          let parcelRequire = nullthrows(
            Object.keys(client).find(k => k.startsWith('parcelRequire')),
          );
          client[parcelRequire](b.getAssetPublicId(nullthrows(entryAsset)));
          resources = client.output.Resources();

          link = resources.props.children;
          assert.equal(link.type, 'link');
          assert.equal(link.props.rel, 'stylesheet');
          assert.equal(link.props.precedence, 'default');
          assert.equal(
            link.props.href,
            '/' +
              path.basename(
                nullthrows(
                  b
                    .getBundles()
                    .find(b => b.type === 'css' && b.name.startsWith('Client')),
                ).filePath,
              ),
          );
        });
      },
    );
  }
});
