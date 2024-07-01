// @flow strict

export type FeatureFlags = {|
  // This feature flag mostly exists to test the feature flag system, and doesn't have any build/runtime effect
  +exampleFeature: boolean,
  /**
   * Enables content hash based invalidation for config keys used in plugins.
   * This allows Assets not to be invalidated when using
   * `config.getConfigFrom(..., {packageKey: '...'})` and the value itself hasn't changed.
   */
  +configKeyInvalidation: boolean,
  /**
   * Rust backed requests
   */
  +parcelV3: boolean,
  /**
   * Use node.js implementation of @parcel/watcher watchman backend
   */
  +useNodeWatcher: boolean,
  /**
   * Store large blobs on randomly generated keys
   */
  +randomLargeBlobKeys: boolean,
|};
