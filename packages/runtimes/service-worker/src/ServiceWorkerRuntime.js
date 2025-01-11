// @flow
import {Runtime} from '@parcel/plugin';
import {urlJoin} from '@parcel/utils';

export default (new Runtime({
  apply({bundle, bundleGraph}) {
    if (bundle.env.context !== 'service-worker') {
      return [];
    }

    let asset = bundle.traverse((node, _, actions) => {
      if (
        node.type === 'dependency' &&
        node.value.specifier === '@parcel/service-worker' &&
        !bundleGraph.isDependencySkipped(node.value)
      ) {
        actions.stop();
        return bundleGraph.getResolvedAsset(node.value, bundle);
      }
    });

    if (!asset) {
      return [];
    }

    let manifest = [];
    let precacheManifest = []
    bundleGraph.traverseBundles(b => {
      if (b.bundleBehavior === 'inline' || b.id === bundle.id) {
        return;
      }

      manifest.push(urlJoin(b.target.publicUrl, b.name));
      precacheManifest.push({ url: urlJoin(b.target.publicUrl, b.name), revision: b.needsStableName ? b.hashReference : null });
    });

    let code = `import {_register} from '@parcel/service-worker';
const manifest = ${JSON.stringify(manifest)};
const precacheManifest = ${JSON.stringify(precacheManifest)};
const version = ${JSON.stringify(bundle.hashReference)};
_register(manifest, precacheManifest, version);
`;

    return [
      {
        filePath: asset.filePath,
        code,
        isEntry: true,
        env: {sourceType: 'module'},
      },
    ];
  },
}): Runtime);
