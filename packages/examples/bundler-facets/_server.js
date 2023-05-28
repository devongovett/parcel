const express = require('express');
const path = require('path');
const fs = require('fs');
const port = 4000;

let routes = [];
try {
  routes = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'dist/routes.json'), 'utf8'),
  ).reverse();
} catch (e) {}

const htmlPrelude = `<pre id="root"></pre>`;

const html = scripts =>
  htmlPrelude +
  '\n' +
  scripts.map(s => `<script type="module" src="/${s}"></script>`).join('\n');

const app = express();

app.use(express.static('dist'));

if (routes.length === 0) {
  app.get('*', (req, res) => {
    res.type('html');
    res.send(html(['index.js']));
  });
} else {
  routes.forEach(({facet, bundles}) => {
    app.get(facet, (req, res) => {
      res.type('html');
      res.send(html(bundles));
    });
  });
}

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
