# parcel-resolver

parcel-resolver implements the Node.js module resolution algorithm.
It supports both CommonJS and ES module resolution, along with many
additional features supported by various tools in the JavaScript ecosystem,
such as TypeScript's tsconfig paths and extension rewriting, the "alias"
and "browser" fields used by bundlers, absolute and tilde paths, and more.
These can be individually turned on or off using feature flags.

For a full description of all supported resolution features, see [Parcel's documentation](https://parceljs.org/features/dependency-resolution/).

# Example

To create a resolver, first create a [Cache]. This stores information about the files
in a [FileSystem], and can be reused between multiple resolvers. A fresh cache
should generally be created once per build to ensure information is up to date.

Next, create a [Resolver] using one of the constructors. For example, `Resolver::node`
creates a Node.js compatible CommonJS resolver, `Resolver::node_esm` creates an ESM resolver,
and `Resolver::parcel` creates a Parcel-compatible resolver. From there you can customize individual
features such as extensions or index files by setting properties on the resolver.

Finally, call `resolver.resolve` to resolve a specifier. This returns a result, along with [Invalidations]
describing the files that should invalidate any resolution caches.

```rust
use parcel_resolver::{Cache, Resolver, SpecifierType, ResolutionAndQuery};
use std::path::Path;

let cache = Cache::default();
let resolver = Resolver::node_esm(Path::new("/path/to/project-root"), &cache);

let res = resolver.resolve(
  "lodash",
  Path::new("/path/to/project-root/index.js"),
  SpecifierType::Esm
);

if let Ok(ResolutionAndQuery { resolution, query }) = res.result {
  // Do something with the resolution!
}
```
