const parcelBabelPreset = require('@parcel/babel-preset');
const path = require('path');

require('@babel/register')({
  ignore: [
    filepath => filepath.includes(path.sep + 'node_modules' + path.sep),
    // Don't run babel over ignore integration tests fixtures.
    // These may include relative babel plugins, and running babel on those causes
    // the plugin to be loaded to compile the plugin.
    path.resolve(__dirname, '../../core/integration-tests/test/integration')
  ],
  presets: [parcelBabelPreset]
});

// This adds the registration to the Node args, which are passed
// to child processes by Node when we fork to create workers.
process.execArgv.push('-r', '@parcel/babel-register');
