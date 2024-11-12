// @flow
import type {PackageManager} from '@parcel/package-manager';
import type {FilePath} from '@parcel/types';

const SHARP_RANGE = '^0.33.5';

// This is used to load sharp on the main thread, which prevents errors when worker threads exit
// See https://sharp.pixelplumbing.com/install#worker-threads and https://github.com/lovell/sharp/issues/2263
module.exports = async (
  packageManager: PackageManager,
  filePath: FilePath,
  shouldAutoInstall: boolean,
  shouldReturn: boolean,
): Promise<any> => {
  let sharp = await packageManager.require('sharp', filePath, {
    range: SHARP_RANGE,
    shouldAutoInstall: shouldAutoInstall,
  });

  if (shouldReturn) {
    return sharp;
  }
};
