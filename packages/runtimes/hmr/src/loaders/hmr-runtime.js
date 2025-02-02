// @flow
/* global HMR_HOST, HMR_PORT, HMR_SERVER_PORT, HMR_ENV_HASH, HMR_SECURE, HMR_USE_SSE, chrome, browser, __parcel__import__, __parcel__importScripts__, ServiceWorkerGlobalScope */

/*::
import type {
  HMRAsset,
  HMRMessage,
} from '@parcel/reporter-dev-server/src/HMRServer.js';
interface ParcelRequire {
  (string): mixed;
  cache: {|[string]: ParcelModule|};
  hotData: {|[string]: mixed|};
  Module: any;
  parent: ?ParcelRequire;
  isParcelRequire: true;
  modules: {|[string]: [Function, {|[string]: string|}]|};
  HMR_BUNDLE_ID: string;
  root: ParcelRequire;
}
interface ParcelModule {
  hot: {|
    data: mixed,
    accept(cb: (Function) => void): void,
    dispose(cb: (mixed) => void): void,
    // accept(deps: Array<string> | string, cb: (Function) => void): void,
    // decline(): void,
    _acceptCallbacks: Array<(Function) => void>,
    _disposeCallbacks: Array<(mixed) => void>,
  |};
}
interface ExtensionContext {
  runtime: {|
    reload(): void,
    getURL(url: string): string;
    getManifest(): {manifest_version: number, ...};
  |};
}
declare var module: {bundle: ParcelRequire, ...};
declare var HMR_HOST: string;
declare var HMR_PORT: string;
declare var HMR_SERVER_PORT: string;
declare var HMR_ENV_HASH: string;
declare var HMR_SECURE: boolean;
declare var HMR_USE_SSE: boolean;
declare var chrome: ExtensionContext;
declare var browser: ExtensionContext;
declare var __parcel__import__: (string) => Promise<void>;
declare var __parcel__importScripts__: (string) => Promise<void>;
declare var globalThis: typeof self;
declare var ServiceWorkerGlobalScope: Object;
*/

var OVERLAY_ID = '__parcel__error__overlay__';

var OldModule = module.bundle.Module;

function Module(moduleName) {
  OldModule.call(this, moduleName);
  this.hot = {
    data: module.bundle.hotData[moduleName],
    _acceptCallbacks: [],
    _disposeCallbacks: [],
    accept: function (fn) {
      this._acceptCallbacks.push(fn || function () {});
    },
    dispose: function (fn) {
      this._disposeCallbacks.push(fn);
    },
  };
  module.bundle.hotData[moduleName] = undefined;
}
module.bundle.Module = Module;
module.bundle.hotData = {};

var checkedAssets /*: {|[string]: boolean|} */,
  disposedAssets /*: {|[string]: boolean|} */,
  assetsToDispose /*: Array<[ParcelRequire, string]> */,
  assetsToAccept /*: Array<[ParcelRequire, string]> */,
  bundleNotFound = false;

function getHostname() {
  return (
    HMR_HOST ||
    (typeof location !== 'undefined' && location.protocol.indexOf('http') === 0
      ? location.hostname
      : 'localhost')
  );
}

function getPort() {
  return (
    HMR_PORT ||
    (typeof location !== 'undefined' ? location.port : HMR_SERVER_PORT)
  );
}

// eslint-disable-next-line no-redeclare
let WebSocket = globalThis.WebSocket;
if (!WebSocket && typeof module.bundle.root === 'function') {
  try {
    // eslint-disable-next-line no-global-assign
    WebSocket = module.bundle.root('ws');
  } catch {
    // ignore.
  }
}

var hostname = getHostname();
var port = getPort();
var protocol =
  HMR_SECURE ||
  (typeof location !== 'undefined' &&
    location.protocol === 'https:' &&
    !['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname))
    ? 'wss'
    : 'ws';

// eslint-disable-next-line no-redeclare
var parent = module.bundle.parent;
if (!parent || !parent.isParcelRequire) {
  // Web extension context
  var extCtx =
    typeof browser === 'undefined'
      ? typeof chrome === 'undefined'
        ? null
        : chrome
      : browser;

  // Safari doesn't support sourceURL in error stacks.
  // eval may also be disabled via CSP, so do a quick check.
  var supportsSourceURL = false;
  try {
    (0, eval)('throw new Error("test"); //# sourceURL=test.js');
  } catch (err) {
    supportsSourceURL = err.stack.includes('test.js');
  }

  var ws;
  if (HMR_USE_SSE) {
    ws = new EventSource('/__parcel_hmr');
  } else {
    try {
      // If we're running in the dev server's node runner, listen for messages on the parent port.
      let {workerData, parentPort} = (module.bundle.root(
        'node:worker_threads',
      ) /*: any*/);
      if (workerData?.__parcel) {
        parentPort.on('message', async message => {
          try {
            await handleMessage(message);
            parentPort.postMessage('updated');
          } catch {
            parentPort.postMessage('restart');
          }
        });

        // After the bundle has finished running, notify the dev server that the HMR update is complete.
        queueMicrotask(() => parentPort.postMessage('ready'));
      }
    } catch {
      if (typeof WebSocket !== 'undefined') {
        try {
          ws = new WebSocket(
            protocol + '://' + hostname + (port ? ':' + port : '') + '/',
          );
        } catch (err) {
          if (err.message) {
            console.error(err.message);
          }
        }
      }
    }
  }

  if (ws) {
    // $FlowFixMe
    ws.onmessage = async function (event /*: {data: string, ...} */) {
      var data /*: HMRMessage */ = JSON.parse(event.data);
      await handleMessage(data);
    };

    if (ws instanceof WebSocket) {
      ws.onerror = function (e) {
        if (e.message) {
          console.error(e.message);
        }
      };

      ws.onclose = function (e) {
        if (process.env.PARCEL_BUILD_ENV !== 'test') {
          console.warn('[parcel] 🚨 Connection to the HMR server was lost');
        }
      };
    }
  }
}

async function handleMessage(data /*: HMRMessage */) {
  checkedAssets = ({} /*: {|[string]: boolean|} */);
  disposedAssets = ({} /*: {|[string]: boolean|} */);
  assetsToAccept = [];
  assetsToDispose = [];
  bundleNotFound = false;

  if (data.type === 'reload') {
    fullReload();
  } else if (data.type === 'update') {
    // Remove error overlay if there is one
    if (typeof document !== 'undefined') {
      removeErrorOverlay();
    }

    let assets = data.assets;

    // Handle HMR Update
    let handled = assets.every(asset => {
      return (
        asset.type === 'css' ||
        (asset.type === 'js' &&
          hmrAcceptCheck(module.bundle.root, asset.id, asset.depsByBundle))
      );
    });

    // Dispatch a custom event in case a bundle was not found. This might mean
    // an asset on the server changed and we should reload the page. This event
    // gives the client an opportunity to refresh without losing state
    // (e.g. via React Server Components). If e.preventDefault() is not called,
    // we will trigger a full page reload.
    if (
      handled &&
      bundleNotFound &&
      assets.some(a => a.envHash !== HMR_ENV_HASH) &&
      typeof window !== 'undefined' &&
      typeof CustomEvent !== 'undefined'
    ) {
      handled = !window.dispatchEvent(
        new CustomEvent('parcelhmrreload', {cancelable: true}),
      );
    }

    if (handled) {
      console.clear();

      // Dispatch custom event so other runtimes (e.g React Refresh) are aware.
      if (typeof window !== 'undefined' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('parcelhmraccept'));
      }

      await hmrApplyUpdates(assets);

      hmrDisposeQueue();

      // Run accept callbacks. This will also re-execute other disposed assets in topological order.
      let processedAssets = {};
      for (let i = 0; i < assetsToAccept.length; i++) {
        let id = assetsToAccept[i][1];

        if (!processedAssets[id]) {
          hmrAccept(assetsToAccept[i][0], id);
          processedAssets[id] = true;
        }
      }
    } else fullReload();
  }

  if (data.type === 'error') {
    // Log parcel errors to console
    for (let ansiDiagnostic of data.diagnostics.ansi) {
      let stack = ansiDiagnostic.codeframe
        ? ansiDiagnostic.codeframe
        : ansiDiagnostic.stack;

      console.error(
        '🚨 [parcel]: ' +
          ansiDiagnostic.message +
          '\n' +
          stack +
          '\n\n' +
          ansiDiagnostic.hints.join('\n'),
      );
    }

    if (typeof document !== 'undefined') {
      // Render the fancy html overlay
      removeErrorOverlay();
      var overlay = createErrorOverlay(data.diagnostics.html);
      // $FlowFixMe
      document.body.appendChild(overlay);
    }
  }
}

function removeErrorOverlay() {
  var overlay = document.getElementById(OVERLAY_ID);
  if (overlay) {
    overlay.remove();
    console.log('[parcel] ✨ Error resolved');
  }
}

function createErrorOverlay(diagnostics) {
  var overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;

  let errorHTML =
    '<div style="background: black; opacity: 0.85; font-size: 16px; color: white; position: fixed; height: 100%; width: 100%; top: 0px; left: 0px; padding: 30px; font-family: Menlo, Consolas, monospace; z-index: 9999;">';

  for (let diagnostic of diagnostics) {
    let stack = diagnostic.frames.length
      ? diagnostic.frames.reduce((p, frame) => {
          return `${p}
<a href="${
            protocol === 'wss' ? 'https' : 'http'
          }://${hostname}:${port}/__parcel_launch_editor?file=${encodeURIComponent(
            frame.location,
          )}" style="text-decoration: underline; color: #888" onclick="fetch(this.href); return false">${
            frame.location
          }</a>
${frame.code}`;
        }, '')
      : diagnostic.stack;

    errorHTML += `
      <div>
        <div style="font-size: 18px; font-weight: bold; margin-top: 20px;">
          🚨 ${diagnostic.message}
        </div>
        <pre>${stack}</pre>
        <div>
          ${diagnostic.hints.map(hint => '<div>💡 ' + hint + '</div>').join('')}
        </div>
        ${
          diagnostic.documentation
            ? `<div>📝 <a style="color: violet" href="${diagnostic.documentation}" target="_blank">Learn more</a></div>`
            : ''
        }
      </div>
    `;
  }

  errorHTML += '</div>';

  overlay.innerHTML = errorHTML;

  return overlay;
}

function fullReload() {
  if (typeof location !== 'undefined' && 'reload' in location) {
    location.reload();
  } else if (
    typeof extCtx !== 'undefined' &&
    extCtx &&
    extCtx.runtime &&
    extCtx.runtime.reload
  ) {
    extCtx.runtime.reload();
  } else {
    try {
      let {workerData, parentPort} = (module.bundle.root(
        'node:worker_threads',
      ) /*: any*/);
      if (workerData?.__parcel) {
        parentPort.postMessage('restart');
      }
    } catch (err) {
      console.error(
        '[parcel] ⚠️ An HMR update was not accepted. Please restart the process.',
      );
    }
  }
}

function getParents(bundle, id) /*: Array<[ParcelRequire, string]> */ {
  var modules = bundle.modules;
  if (!modules) {
    return [];
  }

  var parents = [];
  var k, d, dep;

  for (k in modules) {
    for (d in modules[k][1]) {
      dep = modules[k][1][d];

      if (dep === id || (Array.isArray(dep) && dep[dep.length - 1] === id)) {
        parents.push([bundle, k]);
      }
    }
  }

  if (bundle.parent) {
    parents = parents.concat(getParents(bundle.parent, id));
  }

  return parents;
}

function updateLink(link) {
  var href = link.getAttribute('href');

  if (!href) {
    return;
  }
  var newLink = link.cloneNode();
  newLink.onload = function () {
    if (link.parentNode !== null) {
      // $FlowFixMe
      link.parentNode.removeChild(link);
    }
  };
  newLink.setAttribute(
    'href',
    // $FlowFixMe
    href.split('?')[0] + '?' + Date.now(),
  );
  // $FlowFixMe
  link.parentNode.insertBefore(newLink, link.nextSibling);
}

var cssTimeout = null;
function reloadCSS() {
  if (cssTimeout || typeof document === 'undefined') {
    return;
  }

  cssTimeout = setTimeout(function () {
    var links = document.querySelectorAll('link[rel="stylesheet"]');
    for (var i = 0; i < links.length; i++) {
      // $FlowFixMe[incompatible-type]
      var href /*: string */ = links[i].getAttribute('href');
      var hostname = getHostname();
      var servedFromHMRServer =
        hostname === 'localhost'
          ? new RegExp(
              '^(https?:\\/\\/(0.0.0.0|127.0.0.1)|localhost):' + getPort(),
            ).test(href)
          : href.indexOf(hostname + ':' + getPort());
      var absolute =
        /^https?:\/\//i.test(href) &&
        href.indexOf(location.origin) !== 0 &&
        !servedFromHMRServer;
      if (!absolute) {
        updateLink(links[i]);
      }
    }

    cssTimeout = null;
  }, 50);
}

function hmrDownload(asset) {
  if (asset.type === 'js') {
    if (typeof document !== 'undefined') {
      let script = document.createElement('script');
      script.src = asset.url + '?t=' + Date.now();
      if (asset.outputFormat === 'esmodule') {
        script.type = 'module';
      }
      return new Promise((resolve, reject) => {
        script.onload = () => resolve(script);
        script.onerror = reject;
        document.head?.appendChild(script);
      });
    } else if (typeof importScripts === 'function') {
      // Worker scripts
      if (asset.outputFormat === 'esmodule') {
        return __parcel__import__(asset.url + '?t=' + Date.now());
      } else {
        return new Promise((resolve, reject) => {
          try {
            __parcel__importScripts__(asset.url + '?t=' + Date.now());
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      }
    }
  }
}

async function hmrApplyUpdates(assets) {
  global.parcelHotUpdate = Object.create(null);

  let scriptsToRemove;
  try {
    // If sourceURL comments aren't supported in eval, we need to load
    // the update from the dev server over HTTP so that stack traces
    // are correct in errors/logs. This is much slower than eval, so
    // we only do it if needed (currently just Safari).
    // https://bugs.webkit.org/show_bug.cgi?id=137297
    // This path is also taken if a CSP disallows eval.
    if (!supportsSourceURL) {
      let promises = assets.map(asset =>
        hmrDownload(asset)?.catch(err => {
          // Web extension fix
          if (
            extCtx &&
            extCtx.runtime &&
            extCtx.runtime.getManifest().manifest_version == 3 &&
            typeof ServiceWorkerGlobalScope != 'undefined' &&
            global instanceof ServiceWorkerGlobalScope
          ) {
            extCtx.runtime.reload();
            return;
          }
          throw err;
        }),
      );

      scriptsToRemove = await Promise.all(promises);
    }

    assets.forEach(function (asset) {
      hmrApply(module.bundle.root, asset);
    });
  } finally {
    delete global.parcelHotUpdate;

    if (scriptsToRemove) {
      scriptsToRemove.forEach(script => {
        if (script) {
          document.head?.removeChild(script);
        }
      });
    }
  }
}

function hmrApply(bundle /*: ParcelRequire */, asset /*:  HMRAsset */) {
  var modules = bundle.modules;
  if (!modules) {
    return;
  }

  if (asset.type === 'css') {
    reloadCSS();
  } else if (asset.type === 'js') {
    let deps = asset.depsByBundle[bundle.HMR_BUNDLE_ID];
    if (deps) {
      if (modules[asset.id]) {
        // Remove dependencies that are removed and will become orphaned.
        // This is necessary so that if the asset is added back again, the cache is gone, and we prevent a full page reload.
        let oldDeps = modules[asset.id][1];
        for (let dep in oldDeps) {
          if (!deps[dep] || deps[dep] !== oldDeps[dep]) {
            let id = oldDeps[dep];
            let parents = getParents(module.bundle.root, id);
            if (parents.length === 1) {
              hmrDelete(module.bundle.root, id);
            }
          }
        }
      }

      if (supportsSourceURL) {
        // Global eval. We would use `new Function` here but browser
        // support for source maps is better with eval.
        (0, eval)(asset.output);
      }

      // $FlowFixMe
      let fn = global.parcelHotUpdate[asset.id];
      modules[asset.id] = [fn, deps];
    }

    // Always traverse to the parent bundle, even if we already replaced the asset in this bundle.
    // This is required in case modules are duplicated. We need to ensure all instances have the updated code.
    if (bundle.parent) {
      hmrApply(bundle.parent, asset);
    }
  }
}

function hmrDelete(bundle, id) {
  let modules = bundle.modules;
  if (!modules) {
    return;
  }

  if (modules[id]) {
    // Collect dependencies that will become orphaned when this module is deleted.
    let deps = modules[id][1];
    let orphans = [];
    for (let dep in deps) {
      let parents = getParents(module.bundle.root, deps[dep]);
      if (parents.length === 1) {
        orphans.push(deps[dep]);
      }
    }

    // Delete the module. This must be done before deleting dependencies in case of circular dependencies.
    delete modules[id];
    delete bundle.cache[id];

    // Now delete the orphans.
    orphans.forEach(id => {
      hmrDelete(module.bundle.root, id);
    });
  } else if (bundle.parent) {
    hmrDelete(bundle.parent, id);
  }
}

function hmrAcceptCheck(
  bundle /*: ParcelRequire */,
  id /*: string */,
  depsByBundle /*: ?{ [string]: { [string]: string } }*/,
) {
  checkedAssets = {};
  if (hmrAcceptCheckOne(bundle, id, depsByBundle)) {
    return true;
  }

  // Traverse parents breadth first. All possible ancestries must accept the HMR update, or we'll reload.
  let parents = getParents(module.bundle.root, id);
  let accepted = false;
  while (parents.length > 0) {
    let v = parents.shift();
    let a = hmrAcceptCheckOne(v[0], v[1], null);
    if (a) {
      // If this parent accepts, stop traversing upward, but still consider siblings.
      accepted = true;
    } else if (a !== null) {
      // Otherwise, queue the parents in the next level upward.
      let p = getParents(module.bundle.root, v[1]);
      if (p.length === 0) {
        // If there are no parents, then we've reached an entry without accepting. Reload.
        accepted = false;
        break;
      }
      parents.push(...p);
    }
  }

  return accepted;
}

function hmrAcceptCheckOne(
  bundle /*: ParcelRequire */,
  id /*: string */,
  depsByBundle /*: ?{ [string]: { [string]: string } }*/,
) {
  var modules = bundle.modules;
  if (!modules) {
    return;
  }

  if (depsByBundle && !depsByBundle[bundle.HMR_BUNDLE_ID]) {
    // If we reached the root bundle without finding where the asset should go,
    // there's nothing to do. Mark as "accepted" so we don't reload the page.
    if (!bundle.parent) {
      bundleNotFound = true;
      return true;
    }

    return hmrAcceptCheckOne(bundle.parent, id, depsByBundle);
  }

  if (checkedAssets[id]) {
    return null;
  }

  checkedAssets[id] = true;

  var cached = bundle.cache[id];
  if (!cached) {
    return true;
  }

  assetsToDispose.push([bundle, id]);

  if (cached && cached.hot && cached.hot._acceptCallbacks.length) {
    assetsToAccept.push([bundle, id]);
    return true;
  }

  return false;
}

function hmrDisposeQueue() {
  // Dispose all old assets.
  for (let i = 0; i < assetsToDispose.length; i++) {
    let id = assetsToDispose[i][1];

    if (!disposedAssets[id]) {
      hmrDispose(assetsToDispose[i][0], id);
      disposedAssets[id] = true;
    }
  }

  assetsToDispose = [];
}

function hmrDispose(bundle /*: ParcelRequire */, id /*: string */) {
  var cached = bundle.cache[id];
  bundle.hotData[id] = {};
  if (cached && cached.hot) {
    cached.hot.data = bundle.hotData[id];
  }

  if (cached && cached.hot && cached.hot._disposeCallbacks.length) {
    cached.hot._disposeCallbacks.forEach(function (cb) {
      cb(bundle.hotData[id]);
    });
  }

  delete bundle.cache[id];
}

function hmrAccept(bundle /*: ParcelRequire */, id /*: string */) {
  // Execute the module.
  bundle(id);

  // Run the accept callbacks in the new version of the module.
  var cached = bundle.cache[id];
  if (cached && cached.hot && cached.hot._acceptCallbacks.length) {
    let assetsToAlsoAccept = [];
    cached.hot._acceptCallbacks.forEach(function (cb) {
      let additionalAssets = cb(function () {
        return getParents(module.bundle.root, id);
      });
      if (Array.isArray(additionalAssets) && additionalAssets.length) {
        assetsToAlsoAccept.push(...additionalAssets);
      }
    });

    if (assetsToAlsoAccept.length) {
      let handled = assetsToAlsoAccept.every(function (a) {
        return hmrAcceptCheck(a[0], a[1]);
      });

      if (!handled) {
        return fullReload();
      }

      hmrDisposeQueue();
    }
  }
}
