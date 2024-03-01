// @flow strict

export type FeatureFlags = {|
  // This feature flag mostly exists to test the feature flag system, and doesn't have any build/runtime effect
  +exampleFeature: boolean,
|};

export const DEFAULT_FEATURE_FLAGS: FeatureFlags = {
  exampleFeature: false,
};
