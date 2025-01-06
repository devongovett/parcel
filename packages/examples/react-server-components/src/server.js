// Server dependencies.
import express from 'express';
import {Readable} from 'node:stream';
import {renderToReadableStream, loadServerAction, decodeReply, decodeAction} from 'react-server-dom-parcel/server.edge';
import {injectRSCPayload} from 'rsc-html-stream/server';

// Client dependencies, used for SSR.
// These must run in the same environment as client components (e.g. same instance of React).
import {createFromReadableStream} from 'react-server-dom-parcel/client.edge' with {env: 'react-client'};
import {renderToReadableStream as renderHTMLToReadableStream} from 'react-dom/server.edge' with {env: 'react-client'};
import ReactClient from 'react' with {env: 'react-client'};

// Page components. These must have "use server-entry" so they are treated as code splitting entry points.
import App from './App';
import FilePage from './FilePage';

const app = express();

app.options('/', function (req, res) {
  res.setHeader('Allow', 'Allow: GET,HEAD,POST');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'rsc-action');
  res.end();
});

app.use(express.static('dist'));

app.get('/', async (req, res) => {
  await render(req, res, <App />, App.bootstrapScript);
});

app.get('/files/*', async (req, res) => {
  await render(req, res, <FilePage file={req.params[0]} />, FilePage.bootstrapScript);
});

app.post('/', async (req, res) => {
  let id = req.get('rsc-action-id');
  let request = new Request('http://localhost' + req.url, {
    method: 'POST',
    headers: req.headers,
    body: Readable.toWeb(req),
    duplex: 'half'
  });

  if (id) {
    let action = await loadServerAction(id);
    let body = req.is('multipart/form-data') ? await request.formData() : await request.text();
    let args = await decodeReply(body);
    let result = action.apply(null, args);
    try {
      // Wait for any mutations
      await result;
    } catch (x) {
      // We handle the error on the client
    }

    await render(req, res, <App />, App.bootstrapScript, result);
  } else {
    // Form submitted by browser (progressive enhancement).
    let formData = await request.formData();
    let action = await decodeAction(formData);
    try {
      // Wait for any mutations
      await action();
    } catch (err) {
      // TODO render error page?
    }
    await render(req, res, <App />, App.bootstrapScript);
  }
});

async function render(req, res, component, bootstrapScript, actionResult) {
  // Render RSC payload.
  let root = component;
  if (actionResult) {
    root = {result: actionResult, root};
  }
  let stream = renderToReadableStream(root);
  if (req.accepts('text/html')) {
    res.setHeader('Content-Type', 'text/html');

    // Use client react to render the RSC payload to HTML.
    let [s1, s2] = stream.tee();
    let data;
    function Content() {
      // Important: this must be constructed inside a component for preinit scripts to be inserted.
      data ??= createFromReadableStream(s1);
      return ReactClient.use(data);
    }

    let htmlStream = await renderHTMLToReadableStream(<Content />, {
      bootstrapScriptContent: bootstrapScript,
    });
    let response = htmlStream.pipeThrough(injectRSCPayload(s2));
    Readable.fromWeb(response).pipe(res);
  } else {
    res.set('Content-Type', 'text/x-component');
    Readable.fromWeb(stream).pipe(res);
  }
}

let server = app.listen(3001);
console.log('Server listening on port 3001');
console.log(import.meta.distDir, import.meta.publicUrl)

if (module.hot) {
  module.hot.dispose(() => {
    server.close();
  });

  module.hot.accept();
}
