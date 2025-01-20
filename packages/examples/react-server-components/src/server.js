import express from 'express';
import {renderRequest, callAction} from '@parcel/rsc/node';

// Page components. These must have "use server-entry" so they are treated as code splitting entry points.
import App from './App';
import FilePage from './FilePage';

const app = express();

app.use(express.static('dist'));

app.get('/', async (req, res) => {
  await renderRequest(req, res, <App />, {component: App});
});

app.get('/files/*', async (req, res) => {
  await renderRequest(req, res, <FilePage file={req.params[0]} />, {component: FilePage});
});

app.post('/', async (req, res) => {
  let id = req.get('rsc-action-id');
  try {
    let {result} = await callAction(req, id);
    let root = <App />;
    if (id) {
      root = {result, root};
    }
    await renderRequest(req, res, root, {component: App});
  } catch (err) {
    await renderRequest(req, res, <h1>{err.toString()}</h1>);
  }
});

app.listen(3001);
console.log('Server listening on port 3001');
