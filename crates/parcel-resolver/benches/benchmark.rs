use criterion::{criterion_group, criterion_main, Criterion};
use node_resolver::{
  errors::{PackageFolderResolveError, PackageFolderResolveIoError, PackageNotFoundError},
  PackageJsonResolver,
};
use std::{
  borrow::Cow,
  hint::black_box,
  path::{Path, PathBuf},
  rc::Rc,
  sync::Arc,
};

fn parcel(from: &Path, resolver: &parcel_resolver::Resolver) {
  for specifier in &[
    "./nested/index.js",
    "@parcel/core",
    "axios",
    "@babel/parser",
  ] {
    let _ = black_box(resolver.resolve(
      black_box(specifier),
      &from,
      parcel_resolver::SpecifierType::Esm,
    ));
  }
}

fn oxc_resolve(from: &Path, resolver: &oxc_resolver::Resolver) {
  for specifier in &[
    "./nested/index.js",
    "@parcel/core",
    "axios",
    "@babel/parser",
  ] {
    let _ = black_box(resolver.resolve(&from, black_box(specifier)));
  }
}

fn rspack_resolve(from: &Path, resolver: &rspack_resolver::Resolver) {
  for specifier in &[
    "./nested/index.js",
    "@parcel/core",
    "axios",
    "@babel/parser",
  ] {
    let _ = black_box(resolver.resolve(&from, black_box(specifier)));
  }
}

#[derive(Debug)]
struct Env;

impl node_resolver::env::NodeResolverEnv for Env {
  fn is_builtin_node_module(&self, _specifier: &str) -> bool {
    false
  }

  fn realpath_sync(&self, path: &Path) -> std::io::Result<std::path::PathBuf> {
    path.canonicalize()
  }

  fn stat_sync(&self, path: &Path) -> std::io::Result<node_resolver::env::NodeResolverFsStat> {
    let metadata = path.symlink_metadata()?;
    if metadata.is_symlink() {
      let metadata = path.metadata()?;
      return Ok(node_resolver::env::NodeResolverFsStat {
        is_file: metadata.is_file(),
        is_dir: metadata.is_dir(),
        is_symlink: true,
      });
    }
    return Ok(node_resolver::env::NodeResolverFsStat {
      is_file: metadata.is_file(),
      is_dir: metadata.is_dir(),
      is_symlink: false,
    });
  }

  fn exists_sync(&self, path: &Path) -> bool {
    path.exists()
  }

  fn pkg_json_fs(&self) -> &dyn deno_package_json::fs::DenoPkgJsonFs {
    self
  }
}

impl deno_package_json::fs::DenoPkgJsonFs for Env {
  fn read_to_string_lossy(&self, path: &Path) -> Result<String, std::io::Error> {
    std::fs::read_to_string(path)
  }
}

impl node_resolver::InNpmPackageChecker for Env {
  fn in_npm_package(&self, specifier: &url::Url) -> bool {
    specifier.scheme() == "file"
      && specifier
        .path()
        .to_ascii_lowercase()
        .contains("/node_modules/")
  }
}

fn join_package_name(path: &Path, package_name: &str) -> PathBuf {
  let mut path = path.to_path_buf();
  // ensure backslashes are used on windows
  for part in package_name.split('/') {
    path = path.join(part);
  }
  path
}

impl node_resolver::NpmResolver for Env {
  fn resolve_package_folder_from_package(
    &self,
    specifier: &str,
    referrer: &url::Url,
  ) -> Result<std::path::PathBuf, node_resolver::errors::PackageFolderResolveError> {
    fn inner(name: &str, referrer: &url::Url) -> Result<PathBuf, PackageFolderResolveError> {
      let maybe_referrer_file = referrer.to_file_path().unwrap();
      let maybe_start_folder = maybe_referrer_file.parent();
      if let Some(start_folder) = maybe_start_folder {
        for current_folder in start_folder.ancestors() {
          let node_modules_folder = if current_folder.ends_with("node_modules") {
            Cow::Borrowed(current_folder)
          } else {
            Cow::Owned(current_folder.join("node_modules"))
          };

          let sub_dir = join_package_name(&node_modules_folder, name);
          if sub_dir.is_dir() {
            return Ok(sub_dir);
          }
        }
      }

      Err(
        PackageNotFoundError {
          package_name: name.to_string(),
          referrer: referrer.clone(),
          referrer_extra: None,
        }
        .into(),
      )
    }

    let path = inner(specifier, referrer)?;
    path.canonicalize().map_err(|err| {
      PackageFolderResolveIoError {
        package_name: specifier.to_string(),
        referrer: referrer.clone(),
        source: err,
      }
      .into()
    })
  }
}

fn deno_resolve(from: &url::Url, resolver: &node_resolver::NodeResolver<Env>) {
  for specifier in &[
    "./nested/index.js",
    "@parcel/core",
    "axios",
    "@babel/parser",
  ] {
    let _ = black_box(resolver.resolve(
      black_box(specifier),
      from,
      node_resolver::NodeModuleKind::Esm,
      node_resolver::NodeResolutionMode::Execution,
    ));
  }
}

fn bench_uncached(c: &mut Criterion) {
  let root = Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .unwrap()
    .parent()
    .unwrap()
    .join("packages/utils/node-resolver-core/test/fixture");
  let from = root.join("foo.js");
  let fs: Arc<dyn parcel_resolver::FileSystem> = Arc::new(parcel_resolver::OsFileSystem::default());
  c.bench_function("uncached/parcel_resolver", |b| {
    b.iter(|| {
      let cache = parcel_resolver::Cache::new(Arc::clone(&fs));
      let resolver = parcel_resolver::Resolver::node_esm(&root, &cache);
      parcel(&from, &resolver)
    })
  });

  c.bench_function("uncached/oxc_resolver", |b| {
    b.iter(|| {
      let oxc = oxc_resolver::Resolver::new(Default::default());
      oxc_resolve(&from, &oxc)
    })
  });

  c.bench_function("uncached/rspack_resolver", |b| {
    b.iter(|| {
      let rspack = rspack_resolver::Resolver::new(Default::default());
      rspack_resolve(&from, &rspack)
    })
  });

  let from_url = url::Url::from_file_path(from).unwrap();
  c.bench_function("uncached/deno", |b| {
    b.iter(|| {
      node_resolver::PackageJsonThreadLocalCache::clear();
      let deno = node_resolver::NodeResolver::new(
        Env,
        Rc::new(Env),
        Rc::new(Env),
        Rc::new(PackageJsonResolver::new(Env)),
      );
      deno_resolve(&from_url, &deno)
    })
  });
}

fn bench_cached(c: &mut Criterion) {
  let root = Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .unwrap()
    .parent()
    .unwrap()
    .join("packages/utils/node-resolver-core/test/fixture");
  let from = root.join("foo.js");
  let fs: Arc<dyn parcel_resolver::FileSystem> = Arc::new(parcel_resolver::OsFileSystem::default());
  let cache = parcel_resolver::Cache::new(Arc::clone(&fs));
  let resolver = parcel_resolver::Resolver::node_esm(&root, &cache);
  c.bench_function("cached/parcel_resolver", |b| {
    b.iter(|| parcel(&from, &resolver))
  });

  let oxc = oxc_resolver::Resolver::new(Default::default());
  c.bench_function("cached/oxc_resolver", |b| {
    b.iter(|| oxc_resolve(&from, &oxc))
  });

  let rspack = rspack_resolver::Resolver::new(Default::default());
  c.bench_function("cached/rspack_resolver", |b| {
    b.iter(|| rspack_resolve(&from, &rspack))
  });

  let from_url = url::Url::from_file_path(from).unwrap();
  let deno = node_resolver::NodeResolver::new(
    Env,
    Rc::new(Env),
    Rc::new(Env),
    Rc::new(PackageJsonResolver::new(Env)),
  );
  c.bench_function("cached/deno", |b| b.iter(|| deno_resolve(&from_url, &deno)));
}

criterion_group!(benches, bench_uncached, bench_cached);
criterion_main!(benches);
