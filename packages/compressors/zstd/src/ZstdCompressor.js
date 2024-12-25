// @flow
import {Compressor} from '@parcel/plugin';
import {compress} from '@mongodb-js/zstd';
import {Transform} from 'stream';

export default (new Compressor({
  compress({options, stream}) {
    if (options.mode !== 'production') {
      return null;
    }

    return {
      stream: stream.pipe(
        new Transform({
          transform(chunk, encoding, cb) {
            compress(chunk, 19).then(
              compressed => cb(null, compressed),
              error => cb(error, null),
            );
          },
        }),
      ),
      type: 'zst',
    };
  },
}): Compressor);
