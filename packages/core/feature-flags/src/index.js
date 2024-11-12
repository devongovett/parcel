// @flow strict

import type {FeatureFlags as _FeatureFlags} from './types';
// We need to do these gymnastics as we don't want flow-to-ts to touch DEFAULT_FEATURE_FLAGS,
// but we want to export FeatureFlags for Flow
export type FeatureFlags = _FeatureFlags;

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  exampleFeature: false,
  useWatchmanWatcher: false,
  importRetry: false,
};

let featureFlagValues: FeatureFlags = {...DEFAULT_FEATURE_FLAGS};

export function setFeatureFlags(flags: FeatureFlags) {
  featureFlagValues = flags;
}

export function getFeatureFlag(flagName: $Keys<FeatureFlags>): boolean {
  return featureFlagValues[flagName];
}
