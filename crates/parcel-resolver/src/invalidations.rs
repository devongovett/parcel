use std::{
  cell::{Cell, RefCell},
  collections::HashSet,
  hash::BuildHasherDefault,
  sync::Arc,
};

use rustc_hash::FxHasher;

use crate::{
  cache::{CachedPath, IdentityHasher},
  ResolverError,
};

/// Files that should invalidate the cache when they are created.
#[derive(PartialEq, Eq, Hash, Debug, Clone)]
pub enum FileCreateInvalidation {
  /// Invalidate the cache if this path is created.
  Path(CachedPath),
  /// Invalidate the cache if a file of the given name is created
  /// above the given path in the file hierarchy.
  FileName {
    file_name: String,
    above: CachedPath,
  },
  /// Invalidate the cache if a file matching the given glob is created.
  Glob(String),
}

/// Tracks the files that are involved with a resolution, in order to invalidate caches.
#[derive(Default, Debug)]
pub struct Invalidations {
  /// Files that should invalidate the cache when they are created.
  pub invalidate_on_file_create:
    RefCell<HashSet<FileCreateInvalidation, BuildHasherDefault<FxHasher>>>,
  /// Files that should invalidate the cache when they are updated.
  pub invalidate_on_file_change: RefCell<HashSet<CachedPath, BuildHasherDefault<IdentityHasher>>>,
  /// Whether the resolution is non-deterministic, and should invalidate on process restart.
  pub invalidate_on_startup: Cell<bool>,
}

impl Invalidations {
  /// Invalidate the cache if this path is created.
  pub fn invalidate_on_file_create(&self, path: CachedPath) {
    self
      .invalidate_on_file_create
      .borrow_mut()
      .insert(FileCreateInvalidation::Path(path));
  }

  /// Invalidate the cache if a file of the given name is created
  /// above the given path in the file hierarchy.
  pub fn invalidate_on_file_create_above<S: Into<String>>(&self, file_name: S, above: CachedPath) {
    self
      .invalidate_on_file_create
      .borrow_mut()
      .insert(FileCreateInvalidation::FileName {
        file_name: file_name.into(),
        above,
      });
  }

  /// Invalidate the cache if a file matching the given glob is created.
  pub fn invalidate_on_glob_create<S: Into<String>>(&self, glob: S) {
    self
      .invalidate_on_file_create
      .borrow_mut()
      .insert(FileCreateInvalidation::Glob(glob.into()));
  }

  /// Invalidate the cache if the given file changes.
  pub fn invalidate_on_file_change(&self, invalidation: CachedPath) {
    self
      .invalidate_on_file_change
      .borrow_mut()
      .insert(invalidation);
  }

  /// Invalidate the cache whenever the process restarts.
  pub fn invalidate_on_startup(&self) {
    self.invalidate_on_startup.set(true)
  }

  /// Extend these invalidations with the given invalidations.
  pub fn extend(&self, other: &Invalidations) {
    for f in other.invalidate_on_file_create.borrow().iter() {
      self
        .invalidate_on_file_create
        .borrow_mut()
        .insert(f.clone());
    }

    for f in other.invalidate_on_file_change.borrow().iter() {
      self
        .invalidate_on_file_change
        .borrow_mut()
        .insert(f.clone());
    }

    if other.invalidate_on_startup.get() {
      self.invalidate_on_startup();
    }
  }

  pub(crate) fn read<V, F: FnOnce() -> Arc<Result<V, ResolverError>>>(
    &self,
    path: &CachedPath,
    f: F,
  ) -> Arc<Result<V, ResolverError>> {
    let res = f();
    match &*res {
      Ok(_) => {
        self.invalidate_on_file_change(path.clone());
      }
      Err(e) => {
        if matches!(e, ResolverError::IOError(..)) {
          self.invalidate_on_file_create(path.clone());
        }
      }
    }
    res
  }
}
