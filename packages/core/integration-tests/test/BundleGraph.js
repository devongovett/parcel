// @flow strict-local

import assert from 'assert';
import path from 'path';
import {bundle, fsFixture, overlayFS} from '@parcel/test-utils';
import type {BundleGraph, BundleGroup, PackagedBundle} from '@parcel/types';

describe('BundleGraph', () => {
  it('can traverse assets across bundles and contexts', async () => {
    let b = await bundle(
      path.join(__dirname, '/integration/worker-shared/index.js'),
    );

    let assets = [];
    b.traverse(node => {
      if (node.type === 'asset') {
        assets.push({
          type: node.type,
          value: path.basename(
            node.value.filePath.replace(/runtime-[0-9a-f]*/g, 'runtime'),
          ),
        });
      }
    });

    assert.deepEqual(assets, [
      {
        type: 'asset',
        value: 'index.js',
      },
      {
        type: 'asset',
        value: 'lodash.js',
      },
      {
        type: 'asset',
        value: 'worker-a.js',
      },
      {
        type: 'asset',
        value: 'lodash.js',
      },
      {
        type: 'asset',
        value: 'worker-b.js',
      },
      {
        type: 'asset',
        value: 'esmodule-helpers.js',
      },
      {
        type: 'asset',
        value: 'runtime.js',
      },
      {
        type: 'asset',
        value: 'get-worker-url.js',
      },
      {
        type: 'asset',
        value: 'runtime.js',
      },
      {
        type: 'asset',
        value: 'get-worker-url.js',
      },
      {
        type: 'asset',
        value: 'esmodule-helpers.js',
      },
    ]);
  });

  describe('getBundlesInBundleGroup', () => {
    let bundleGraph: BundleGraph<PackagedBundle>;
    let bundleGroup: BundleGroup;
    let dir = path.join(__dirname, 'get-bundles-in-bundle-group');

    before(async () => {
      await overlayFS.mkdirp(dir);

      await fsFixture(overlayFS, dir)`
        logo.svg:
          <svg></svg>

        index.jsx:
          import logo from 'data-url:./logo.svg';

        yarn.lock: {}
      `;

      bundleGraph = await bundle(path.join(dir, 'index.jsx'), {
        inputFS: overlayFS,
      });

      bundleGroup = bundleGraph.getBundleGroupsContainingBundle(
        bundleGraph.getBundles({includeInline: true})[0],
      )[0];
    });

    after(async () => {
      await overlayFS.rimraf(dir);
    });

    it('does not return inlineAssets by default', () => {
      const bundles = bundleGraph.getBundlesInBundleGroup(bundleGroup);

      assert.deepEqual(
        bundles.map(b => b.bundleBehavior),
        [null],
      );
    });

    it('does not return inlineAssets when requested', () => {
      const bundles = bundleGraph.getBundlesInBundleGroup(bundleGroup, {
        includeInline: false,
      });

      assert.deepEqual(
        bundles.map(b => b.bundleBehavior),
        [null],
      );
    });

    it('returns inlineAssets when requested', () => {
      const bundles = bundleGraph.getBundlesInBundleGroup(bundleGroup, {
        includeInline: true,
      });

      assert.deepEqual(
        bundles.map(b => b.bundleBehavior),
        [null, 'inline'],
      );
    });
  });
});
