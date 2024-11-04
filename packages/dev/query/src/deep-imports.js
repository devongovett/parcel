// @flow
/* eslint-disable monorepo/no-internal-import */
import typeof AssetGraph from '@parcel/core/src/AssetGraph.js';
import typeof BundleGraph, {
  bundleGraphEdgeTypes,
} from '@parcel/core/src/BundleGraph.js';
import typeof RequestTracker, {
  RequestGraph,
} from '@parcel/core/src/RequestTracker.js';
import typeof {requestGraphEdgeTypes} from '@parcel/core/src/RequestTracker.js';
import typeof {LMDBCache} from '@parcel/cache/src/LMDBCache.js';
import typeof {Priority} from '@parcel/core/src/types.js';
import typeof {fromProjectPathRelative} from '@parcel/core/src/projectPath.js';

const v =
  process.env.PARCEL_BUILD_ENV === 'production'
    ? {
        // Split up require specifier to outsmart packages/dev/babel-register/babel-plugin-module-translate.js
        // $FlowFixMe(unsupported-syntax)
        AssetGraph: require('@parcel/core' + '/lib/AssetGraph.js').default,
        // $FlowFixMe(unsupported-syntax)
        BundleGraph: require('@parcel/core' + '/lib/BundleGraph.js'),
        // $FlowFixMe(unsupported-syntax)
        RequestTracker: require('@parcel/core' + '/lib/RequestTracker.js'),
        // $FlowFixMe(unsupported-syntax)
        LMDBCache: require('@parcel/cache' + '/lib/LMDBCache.js').LMDBCache,
        // $FlowFixMe(unsupported-syntax)
        Priority: require('@parcel/core' + '/lib/types.js').Priority,
        // $FlowFixMe(unsupported-syntax)
        fromProjectPathRelative: require('@parcel/core' + '/lib/projectPath.js')
          .fromProjectPathRelative,
      }
    : {
        AssetGraph: require('@parcel/core/src/AssetGraph.js').default,
        BundleGraph: require('@parcel/core/src/BundleGraph.js'),
        RequestTracker: require('@parcel/core/src/RequestTracker.js'),
        LMDBCache: require('@parcel/cache/src/LMDBCache.js').LMDBCache,
        Priority: require('@parcel/core/src/types.js').Priority,
        fromProjectPathRelative: require('@parcel/core/src/projectPath.js')
          .fromProjectPathRelative,
      };

module.exports = (v: {|
  AssetGraph: AssetGraph,
  BundleGraph: {
    default: BundleGraph,
    bundleGraphEdgeTypes: bundleGraphEdgeTypes,
    ...
  },
  RequestTracker: {
    default: RequestTracker,
    RequestGraph: RequestGraph,
    requestGraphEdgeTypes: requestGraphEdgeTypes,
    ...
  },
  LMDBCache: LMDBCache,
  Priority: Priority,
  fromProjectPathRelative: fromProjectPathRelative,
|});
