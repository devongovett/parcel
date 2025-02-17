// @flow strict-local
import {Optimizer} from '@parcel/plugin';
import {blobToBuffer} from '@parcel/utils';
import {optimizeSvg} from '@parcel/rust';

export default (new Optimizer({
  async optimize({bundle, contents, map}) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map};
    }

    let code = await blobToBuffer(contents);
    let res = optimizeSvg({
      code,
    });

    return {
      contents: res.code,
    };
  },
}): Optimizer);
