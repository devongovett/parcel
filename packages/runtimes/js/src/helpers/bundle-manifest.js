var mapping = new Map();

export function register(baseUrl, manifest) {
  for (var i = 0; i < manifest.length - 1; i += 2) {
    mapping.set(manifest[i], {
      baseUrl: baseUrl,
      path: manifest[i + 1],
    });
  }
}

export function resolve(id) {
  var resolved = mapping.get(id);
  if (resolved == null) {
    throw new Error('Could not resolve bundle with id ' + id);
  }
  return new URL(resolved.path, resolved.baseUrl).toString();
}
