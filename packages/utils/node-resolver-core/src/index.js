// @flow

import {getFeatureFlag} from '@parcel/feature-flags';
import {Resolver as ResolverNew, ResolverOld} from '@parcel/rust';

export const ResolverBase: typeof ResolverNew = getFeatureFlag(
  'ownedResolverStructures',
)
  ? ResolverNew
  : ResolverOld;

export {default} from './Wrapper';
export {init} from '@parcel/rust';
