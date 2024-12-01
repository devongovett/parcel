// @flow strict-local

import {Transformer} from '@parcel/plugin';

export default (new Transformer({
  transform({asset}) {
    asset.bundleBehavior = 'isolated';
    asset.meta.jsRuntime = 'url';
    return [asset];
  },
}): Transformer);
