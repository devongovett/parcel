const path = require('path');

const resolve = request => {
  if (request === 'testmodule/') {
    return path.join(__dirname, 'pnp', 'testmodule');
  } else if (request === 'pnpapi') {
    return __filename;
  } else if (request.startsWith('@parcel/')) {
    // Use node_modules path for parcel packages so source field is used.
    return path.join(__dirname, '../../../../../../node_modules/', request);
  } else if (/^((@[^/]+\/[^/]+)|[^/]+)\/?$/.test(request)) {
    return path.dirname(require.resolve(path.join(request, 'package.json')));
  } else {
    return require.resolve(request);
  }
};

module.exports = {resolveToUnqualified: resolve, resolveRequest: resolve};
