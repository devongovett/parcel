use bitflags::bitflags;
use dashmap::DashSet;
use rustc_hash::FxHasher;

use crate::{
  fs::FileKind,
  package_json::PackageJson,
  tsconfig::{TsConfig, TsConfigWrapper},
  FileSystem, ResolverError,
};
use std::{
  cell::UnsafeCell,
  ffi::OsStr,
  hash::{BuildHasherDefault, Hash, Hasher},
  ops::Deref,
  path::{is_separator, Component, Path, PathBuf},
  sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
  },
};

/// Stores various cached info about file paths.
pub struct Cache {
  pub fs: Arc<dyn FileSystem>,
  paths: DashSet<PathEntry<'static>, BuildHasherDefault<IdentityHasher>>,
}

/// An entry in the path cache. Can also be borrowed for lookups without allocations.
enum PathEntry<'a> {
  Owned(Arc<PathInfo>),
  Borrowed { hash: u64, path: &'a Path },
}

impl<'a> Hash for PathEntry<'a> {
  fn hash<H: Hasher>(&self, state: &mut H) {
    match self {
      PathEntry::Owned(info) => {
        info.hash.hash(state);
      }
      PathEntry::Borrowed { hash, .. } => {
        hash.hash(state);
      }
    }
  }
}

impl<'a> PartialEq for PathEntry<'a> {
  fn eq(&self, other: &Self) -> bool {
    let self_path = match self {
      PathEntry::Owned(info) => &info.path,
      PathEntry::Borrowed { path, .. } => *path,
    };
    let other_path = match other {
      PathEntry::Owned(info) => &info.path,
      PathEntry::Borrowed { path, .. } => *path,
    };
    self_path.as_os_str() == other_path.as_os_str()
  }
}

impl<'a> Eq for PathEntry<'a> {}

#[cfg(not(target_arch = "wasm32"))]
impl Default for Cache {
  fn default() -> Self {
    Cache::new(Arc::new(crate::fs::OsFileSystem))
  }
}

impl Cache {
  /// Creates an empty cache with the given file system.
  pub fn new(fs: Arc<dyn FileSystem>) -> Cache {
    Cache {
      fs,
      paths: DashSet::default(),
    }
  }

  /// Returns cached info for a pre-normalized path.
  pub fn get<P: AsRef<Path>>(&self, path: P) -> CachedPath {
    self.get_path(path.as_ref())
  }

  /// Normalizes the given path and returns its cached info.
  pub fn get_normalized<P: AsRef<Path>>(&self, path: P) -> CachedPath {
    self.get_path(&normalize_path(path.as_ref()))
  }

  fn get_path(&self, path: &Path) -> CachedPath {
    let mut hasher = FxHasher::default();
    path.as_os_str().hash(&mut hasher);
    let hash = hasher.finish();

    let key = PathEntry::Borrowed { hash, path };

    // A DashMap is just an array of RwLock<HashSet>, sharded by hash to reduce lock contention.
    // This uses the low level raw API to avoid cloning the value when using the `entry` method.
    // First, find which shard the value is in, and check to see if we already have a value in the map.
    let shard = self.paths.determine_shard(hash as usize);
    {
      // Scope the read lock.
      let map = self.paths.shards()[shard].read();
      if let Some((PathEntry::Owned(entry), _)) = map.get(hash, |v| v.0 == key) {
        return CachedPath(Arc::clone(entry));
      }
    }

    // If that wasn't found, we need to create a new entry.
    let parent = path
      .parent()
      .map(|p| CachedPath(Arc::clone(&self.get(p).0)));
    let mut flags = parent.as_ref().map_or(PathFlags::empty(), |p| {
      p.0.flags & PathFlags::IN_NODE_MODULES
    });
    if matches!(path.file_name(), Some(f) if f == "node_modules") {
      flags |= PathFlags::IS_NODE_MODULES | PathFlags::IN_NODE_MODULES;
    }

    let info = Arc::new(PathInfo {
      hash,
      path: path.to_path_buf(),
      parent,
      flags,
      kind: OnceLock::new(),
      canonical: OnceLock::new(),
      canonicalizing: AtomicU64::new(0),
      package_json: OnceLock::new(),
      tsconfig: OnceLock::new(),
    });

    self.paths.insert(PathEntry::Owned(Arc::clone(&info)));
    CachedPath(info)
  }
}

pub(crate) mod private {
  use super::*;

  #[allow(clippy::large_enum_variant)]
  /// Special Cow implementation for a Cache that doesn't require Clone.
  pub enum CacheCow<'a> {
    Borrowed(&'a Cache),
    Owned(Cache),
  }

  impl<'a> Deref for CacheCow<'a> {
    type Target = Cache;

    fn deref(&self) -> &Self::Target {
      match self {
        CacheCow::Borrowed(c) => c,
        CacheCow::Owned(c) => c,
      }
    }
  }

  impl<'a> From<Cache> for CacheCow<'a> {
    fn from(value: Cache) -> Self {
      CacheCow::Owned(value)
    }
  }

  impl<'a> From<&'a Cache> for CacheCow<'a> {
    fn from(value: &'a Cache) -> Self {
      CacheCow::Borrowed(value)
    }
  }
}

bitflags! {
  struct PathFlags: u8 {
    /// Whether this path is inside a node_modules directory.
    const IN_NODE_MODULES = 1 << 0;
    /// Whether this path is a node_modules directory.
    const IS_NODE_MODULES = 1 << 1;
  }
}

/// Cached info about a file path.
struct PathInfo {
  hash: u64,
  path: PathBuf,
  flags: PathFlags,
  parent: Option<CachedPath>,
  kind: OnceLock<FileKind>,
  canonical: OnceLock<Result<CachedPath, ResolverError>>,
  canonicalizing: AtomicU64,
  package_json: OnceLock<Arc<Result<PackageJson, ResolverError>>>,
  tsconfig: OnceLock<Arc<Result<TsConfigWrapper, ResolverError>>>,
}

#[derive(Clone)]
pub struct CachedPath(Arc<PathInfo>);

impl CachedPath {
  /// Returns a std Path.
  pub fn as_path(&self) -> &Path {
    self.0.path.as_path()
  }

  /// Returns the parent path.
  pub fn parent(&self) -> Option<&CachedPath> {
    self.0.parent.as_ref()
  }

  fn kind(&self, fs: &dyn FileSystem) -> FileKind {
    *self.0.kind.get_or_init(|| fs.kind(self.as_path()))
  }

  /// Returns whether the path is a file.
  pub fn is_file(&self, fs: &dyn FileSystem) -> bool {
    self.kind(fs).contains(FileKind::IS_FILE)
  }

  /// Returns whether the path is a directory.
  pub fn is_dir(&self, fs: &dyn FileSystem) -> bool {
    self.kind(fs).contains(FileKind::IS_DIR)
  }

  /// Returns whether the path is a node_modules directory.
  pub fn is_node_modules(&self) -> bool {
    self.0.flags.contains(PathFlags::IS_NODE_MODULES)
  }

  /// Returns whether the path is inside a node_modules directory.
  pub fn in_node_modules(&self) -> bool {
    self.0.flags.contains(PathFlags::IN_NODE_MODULES)
  }

  /// Returns the canonical path, resolving all symbolic links.
  pub fn canonicalize(&self, cache: &Cache) -> Result<CachedPath, ResolverError> {
    // Check if this thread is already canonicalizing. If so, we have found a circular symlink.
    // If a different thread is canonicalizing, OnceLock will queue this thread to wait for the result.
    let tid = THREAD_ID.with(|t| *t);
    if self.0.canonicalizing.load(Ordering::Acquire) == tid {
      return Err(std::io::Error::new(std::io::ErrorKind::NotFound, "Circular symlink").into());
    }

    self
      .0
      .canonical
      .get_or_init(|| {
        self.0.canonicalizing.store(tid, Ordering::Release);

        let res = self
          .parent()
          .map(|parent| {
            parent.canonicalize(cache).and_then(|parent_canonical| {
              let path = parent_canonical.join(
                self
                  .as_path()
                  .strip_prefix(parent.as_path())
                  .map_err(|_| ResolverError::UnknownError)?,
                cache,
              );

              if self.kind(&*cache.fs).contains(FileKind::IS_SYMLINK) {
                let link = cache.fs.read_link(path.as_path())?;
                if link.is_absolute() {
                  return cache.get(&normalize_path(&link)).canonicalize(cache);
                } else {
                  return path.resolve(&link, cache).canonicalize(cache);
                }
              }

              Ok(path)
            })
          })
          .unwrap_or_else(|| Ok(self.clone()));

        self.0.canonicalizing.store(0, Ordering::Release);
        res
      })
      .clone()
  }

  /// Returns an iterator over all ancestor paths.
  pub fn ancestors<'a>(&'a self) -> impl Iterator<Item = &'a CachedPath> {
    std::iter::successors(Some(self), |p| p.parent())
  }

  /// Returns the file name of this path (the final path component).
  pub fn file_name(&self) -> Option<&OsStr> {
    self.as_path().file_name()
  }

  /// Returns the file extension of this path.
  pub fn extension(&self) -> Option<&OsStr> {
    self.as_path().extension()
  }

  /// Returns a new path with the given path segment appended to this path.
  pub fn join<P: AsRef<OsStr>>(&self, segment: P, cache: &Cache) -> CachedPath {
    SCRATCH_PATH.with(|path| {
      let path = unsafe { &mut *path.get() };
      path.clear();
      path.as_mut_os_string().push(self.as_path().as_os_str());
      push_normalized(path, segment.as_ref());
      cache.get(path)
    })
  }

  /// Returns a new path with the given node_modules directory appended to this path.
  pub fn join_module(&self, module: &str, cache: &Cache) -> CachedPath {
    SCRATCH_PATH.with(|path| {
      let path = unsafe { &mut *path.get() };
      path.clear();
      path.as_mut_os_string().push(self.as_path().as_os_str());
      path.push("node_modules");
      push_normalized(path, module);
      cache.get(path)
    })
  }

  /// Returns a new path with the given node_modules directory and package subpath appended to this path.
  pub fn join_package(&self, module: &str, subpath: &str, cache: &Cache) -> CachedPath {
    SCRATCH_PATH.with(|path| {
      let path = unsafe { &mut *path.get() };
      path.clear();
      path.as_mut_os_string().push(self.as_path().as_os_str());
      push_normalized(path, module);
      push_normalized(path, subpath);
      cache.get(path)
    })
  }

  /// Returns a new path by resolving the given subpath (including "." and ".." components) with this path.
  pub fn resolve(&self, subpath: &Path, cache: &Cache) -> CachedPath {
    SCRATCH_PATH.with(|path| {
      let path = unsafe { &mut *path.get() };
      path.clear();
      if let Some(parent) = self.0.parent.as_ref() {
        path.as_mut_os_string().push(parent.0.path.as_os_str());
      }

      for component in subpath.components() {
        match component {
          Component::Prefix(..) | Component::RootDir => unreachable!(),
          Component::CurDir => {}
          Component::ParentDir => {
            path.pop();
          }
          Component::Normal(c) => {
            path.push(c);
          }
        }
      }

      cache.get(path)
    })
  }

  /// Returns a new path by appending the given file extension (without leading ".") with this path.
  pub fn add_extension(&self, ext: &str, cache: &Cache) -> CachedPath {
    SCRATCH_PATH.with(|path| {
      let path = unsafe { &mut *path.get() };
      path.clear();
      let s = path.as_mut_os_string();
      s.push(self.as_path().as_os_str());
      s.push(".");
      s.push(ext);
      cache.get(path)
    })
  }

  /// Returns the parsed package.json at this path.
  pub fn package_json(&self, cache: &Cache) -> Arc<Result<PackageJson, ResolverError>> {
    self
      .0
      .package_json
      .get_or_init(|| Arc::new(PackageJson::read(self, cache)))
      .clone()
  }

  /// Returns the parsed tsconfig.json at this path.
  pub fn tsconfig<F: FnOnce(&mut TsConfigWrapper) -> Result<(), ResolverError>>(
    &self,
    cache: &Cache,
    process: F,
  ) -> Arc<Result<TsConfigWrapper, ResolverError>> {
    self
      .0
      .tsconfig
      .get_or_init(|| Arc::new(TsConfig::read(self, process, cache)))
      .clone()
  }
}

static THREAD_COUNT: AtomicU64 = AtomicU64::new(1);

// Per-thread pre-allocated path that is used to perform operations on paths more quickly.
thread_local! {
  pub static SCRATCH_PATH: UnsafeCell<PathBuf> = UnsafeCell::new(PathBuf::with_capacity(256));
  pub static THREAD_ID: u64 = THREAD_COUNT.fetch_add(1, Ordering::SeqCst);
}

#[cfg(windows)]
#[inline]
fn push_normalized<S: AsRef<OsStr>>(path: &mut PathBuf, s: S) {
  // PathBuf::push does not normalize separators, so on Windows, push each part separately.
  // Note that this does not use Path::components because that also strips the trailing separator.
  let bytes = s.as_ref().as_encoded_bytes();
  for part in bytes.split(|b| *b == b'/') {
    path.push(unsafe { OsStr::from_encoded_bytes_unchecked(part) });
  }
}

#[cfg(not(windows))]
#[inline]
fn push_normalized<S: AsRef<OsStr>>(path: &mut PathBuf, s: S) {
  path.push(s.as_ref());
}

impl Hash for CachedPath {
  fn hash<H: Hasher>(&self, state: &mut H) {
    self.0.hash.hash(state);
  }
}

impl PartialEq for CachedPath {
  fn eq(&self, other: &Self) -> bool {
    // Cached paths always point to unique values, so we only need to compare the pointers.
    std::ptr::eq(Arc::as_ptr(&self.0), Arc::as_ptr(&other.0))
  }
}

impl Eq for CachedPath {}

impl std::fmt::Debug for CachedPath {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.0.path.fmt(f)
  }
}

/// A hasher that just passes through a value that is already a hash.
#[derive(Default)]
pub struct IdentityHasher {
  hash: u64,
}

impl Hasher for IdentityHasher {
  fn write(&mut self, bytes: &[u8]) {
    if bytes.len() == 8 {
      self.hash = u64::from_ne_bytes([
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
      ])
    } else {
      unreachable!()
    }
  }

  fn finish(&self) -> u64 {
    self.hash
  }
}

pub fn normalize_path(path: &Path) -> PathBuf {
  // Normalize path components to resolve ".." and "." segments.
  // https://github.com/rust-lang/cargo/blob/fede83ccf973457de319ba6fa0e36ead454d2e20/src/cargo/util/paths.rs#L61
  let mut components = path.components().peekable();
  let mut ret = if let Some(c @ Component::Prefix(..)) = components.peek().cloned() {
    components.next();
    PathBuf::from(c.as_os_str())
  } else {
    PathBuf::new()
  };

  for component in components {
    match component {
      Component::Prefix(..) => unreachable!(),
      Component::RootDir => {
        ret.push(component.as_os_str());
      }
      Component::CurDir => {}
      Component::ParentDir => {
        ret.pop();
      }
      Component::Normal(c) => {
        ret.push(c);
      }
    }
  }

  // If the path ends with a separator, add an additional empty component.
  if matches!(path.as_os_str().as_encoded_bytes().last(), Some(b) if is_separator(*b as char)) {
    ret.push("");
  }

  ret
}

#[cfg(test)]
mod test {
  use crate::OsFileSystem;

  use super::*;
  use assert_fs::prelude::*;

  #[test]
  fn test_canonicalize() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(windows)]
    if !is_elevated::is_elevated() {
      println!("skipping symlink tests due to missing permissions");
      return Ok(());
    }

    let dir = assert_fs::TempDir::new()?;
    dir.child("foo/bar.js").write_str("")?;
    dir.child("root.js").write_str("")?;

    dir
      .child("symlink")
      .symlink_to_file(Path::new("foo").join("bar.js"))?;
    dir
      .child("foo/symlink")
      .symlink_to_file(Path::new("..").join("root.js"))?;
    dir
      .child("absolute")
      .symlink_to_file(dir.child("root.js").path())?;
    dir
      .child("recursive")
      .symlink_to_file(Path::new("foo").join("symlink"))?;
    dir.child("cycle").symlink_to_file("cycle1")?;
    dir.child("cycle1").symlink_to_file("cycle")?;
    dir
      .child("absolute_cycle")
      .symlink_to_file(dir.child("absolute_cycle1").path())?;
    dir
      .child("absolute_cycle1")
      .symlink_to_file(dir.child("absolute_cycle").path())?;
    dir.child("a/b/c").create_dir_all()?;
    dir.child("a/b/e").symlink_to_file("..")?;
    dir.child("a/d").symlink_to_file("..")?;
    dir.child("a/b/c/x.txt").write_str("")?;
    dir
      .child("a/link")
      .symlink_to_file(dir.child("a/b").path())?;

    let fs = OsFileSystem::default();
    let cache = Cache::new(Arc::new(fs));

    assert_eq!(
      cache
        .get(dir.child("symlink").path())
        .canonicalize(&cache)?,
      cache
        .get(dir.child("foo/bar.js").path())
        .canonicalize(&cache)?
    );
    assert_eq!(
      cache
        .get(dir.child("foo/symlink").path())
        .canonicalize(&cache)?,
      cache
        .get(dir.child("root.js").path())
        .canonicalize(&cache)?
    );
    assert_eq!(
      cache
        .get(dir.child("absolute").path())
        .canonicalize(&cache)?,
      cache
        .get(dir.child("root.js").path())
        .canonicalize(&cache)?
    );
    assert_eq!(
      cache
        .get(dir.child("recursive").path())
        .canonicalize(&cache)?,
      cache
        .get(dir.child("root.js").path())
        .canonicalize(&cache)?
    );
    assert!(cache
      .get(dir.child("cycle").path())
      .canonicalize(&cache)
      .is_err());
    assert!(cache
      .get(dir.child("absolute_cycle").path())
      .canonicalize(&cache)
      .is_err());
    assert_eq!(
      cache
        .get(dir.child("a/b/e/d/a/b/e/d/a").path())
        .canonicalize(&cache)?,
      cache.get(dir.child("a").path()).canonicalize(&cache)?
    );
    assert_eq!(
      cache
        .get(dir.child("a/link/c/x.txt").path())
        .canonicalize(&cache)?,
      cache
        .get(dir.child("a/b/c/x.txt").path())
        .canonicalize(&cache)?
    );

    Ok(())
  }
}
