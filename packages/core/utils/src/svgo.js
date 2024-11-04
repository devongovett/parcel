// @flow
export function detectSVGOVersion(
  config: any,
): {|version: 3|} | {|version: 2, path: string|} {
  if (!config) {
    return {version: 3};
  }

  // These options were removed in v2.
  if (config.full != null || config.svg2js != null) {
    return {version: 2, path: config.full != null ? '/full' : '/svg2js'};
  }

  if (Array.isArray(config.plugins)) {
    // Custom plugins in v2 had additional (required) fields that don't exist anymore.
    let v2Plugin = config.plugins.findIndex(
      p => p?.type != null || (p?.fn && p?.params != null),
    );
    if (v2Plugin !== -1) {
      let field = config.plugins[v2Plugin].type != null ? 'type' : 'params';
      return {version: 2, path: `/plugins/${v2Plugin}/${field}`};
    }

    // the cleanupIDs plugin lost the prefix option in v3.
    let cleanupIdsIndex = config.plugins.findIndex(
      p => p?.name === 'cleanupIDs',
    );
    let cleanupIDs =
      cleanupIdsIndex !== -1 ? config.plugins[cleanupIdsIndex] : null;
    if (cleanupIDs?.params?.prefix != null) {
      return {version: 2, path: `/plugins/${cleanupIdsIndex}/params/prefix`};
    }

    // Automatically migrate some options from SVGO 2 config files.
    config.plugins = config.plugins.filter(p => p?.active !== false);

    for (let i = 0; i < config.plugins.length; i++) {
      let p = config.plugins[i];
      if (p === 'cleanupIDs') {
        config.plugins[i] = 'cleanupIds';
      }

      if (p?.name === 'cleanupIDs') {
        config.plugins[i].name = 'cleanupIds';
      }
    }
  }

  return {version: 3};
}
