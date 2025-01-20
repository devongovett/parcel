import express from 'express';
import {renderRequest, callAction} from '@parcel/rsc/node';

// Page components. These must have "use server-entry" so they are treated as code splitting entry points.
import {Page} from './Page';

const app = express();

app.use(express.static('dist'));

app.get('/', async (req, res) => {
  await renderRequest(req, res, <Page />, {component: Page});
});

app.post('/', async (req, res) => {
  let id = req.get('rsc-action-id');
  let result = await callAction(req, id);
  let root: any = <Page />;
  if (id) {
    root = {result, root};
  }
  await renderRequest(req, res, root, {component: Page});
});

app.listen(3001);
console.log('Server listening on port 3001');
