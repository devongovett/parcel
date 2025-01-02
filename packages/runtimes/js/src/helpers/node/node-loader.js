const url = require('url');
const {createRequire} = require('module');

module.exports = function loadNodeModule(bundle) {
  let path = url.fileURLToPath(bundle);
  let require = createRequire(path);
  return require(path);
};
