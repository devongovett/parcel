import assert from 'assert';
import path from 'path';
import {bundle as _bundle, run, mergeParcelOptions} from '@parcel/test-utils';

const bundle = (name, opts = {}) => {
  return _bundle(
    name,
    // $FlowFixMe
    mergeParcelOptions(
      {
        defaultTargetOptions: {
          shouldScopeHoist: true,
        },
      },
      opts,
    ),
  );
};

describe('_test', function () {
  it('_test', async function () {
    let b = await bundle(path.join(__dirname, '/integration/_test/index.js'));

    let output = await run(b);
    assert.strictEqual(output, 'foo');
  });
});
