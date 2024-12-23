import {Namer} from '@parcel/plugin';
import path from 'path';

export default new Namer({
  name({bundle, bundleGraph}) {
    let bundleGroup = bundleGraph.getBundleGroupsContainingBundle(bundle)[0];
    let isEntry = bundleGraph.isEntryBundleGroup(bundleGroup);
    let main = bundle.getMainEntry();
    if (isEntry && main) {
      // Rename entry bundles to use the HTML extension, which will be true after they are executed during the build.
      let entryRoot = bundleGraph.getEntryRoot(bundle.target);
      let name =
        path.basename(main.filePath, path.extname(main.filePath)) + '.html';
      return path
        .join(path.relative(entryRoot, path.dirname(main.filePath)), name)
        .replace(/\.\.(\/|\\)/g, 'up_$1');
    }
  },
});
