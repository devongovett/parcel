// @flow strict-local
import {Optimizer} from '@parcel/plugin';
import {blobToBuffer} from '@parcel/utils';
import {optimizeHtml} from '@parcel/rust';

export default (new Optimizer({
  async optimize({bundle, contents, map}) {
    if (!bundle.env.shouldOptimize) {
      return {contents, map};
    }

    let code = await blobToBuffer(contents);
    let res = optimizeHtml({
      code,
    });

    return {
      contents: res.code,
    };
  },
}): Optimizer);
