use std::{
  collections::{HashMap, HashSet},
  fmt::{Debug, Display},
  hash::{BuildHasherDefault, Hash, Hasher},
  ops::Deref,
  path::{Path, PathBuf},
  sync::OnceLock,
};

use dashmap::{DashMap, SharedValue};
use gxhash::{GxBuildHasher, GxHasher};
use scoped_tls::scoped_thread_local;
use serde::{Deserialize, Serialize};

/// An Interned value is a unique pointer to a value.
/// Interned values are very cheap to compare, clone, and hash,
/// but they are never freed until the program exits.
pub struct Interned<T: 'static + Sized>(&'static Entry<T>);

/// An Interner is what stores unique interned values.
pub struct Interner<T: 'static + Sized> {
  map: DashMap<&'static T, &'static Entry<T>, GxBuildHasher>,
}

struct Entry<T: Sized> {
  data: T,
  hash: u64,
}

impl<T: Hash + Eq> Interner<T> {
  pub fn new() -> Self {
    Self {
      map: DashMap::with_hasher(GxBuildHasher::default()),
    }
  }

  pub fn intern(&self, value: T) -> Interned<T> {
    // A DashMap is just an array of RwLock<HashSet>, sharded by hash to reduce lock contention.
    // This uses the low level raw API to avoid cloning the value when using the `entry` method.
    // First, find which shard the value is in, and check to see if we already have a value in the map.
    let shard = self.map.determine_map(&value);
    {
      // Scope the read lock.
      let map = self.map.shards()[shard].read();
      if let Some(entry) = map.get(&value) {
        return Interned(entry.get());
      }
    }

    // If that wasn't found, we need to create a new entry. Interned values are never freed
    // until the program exits, so we can just leak a Box to ensure the pointer never moves.
    // This is inserted into the previously determined shard using a write lock this time.
    let hash = hash_value(&value);
    let entry: &'static Entry<T> = Box::leak(Box::new(Entry { data: value, hash }));
    let mut map = self.map.shards()[shard].write();
    map.insert(&entry.data, SharedValue::new(entry));
    Interned(entry)
  }

  pub fn clear(&self) {
    self.map.clear();
  }
}

fn hash_value<T: Hash>(value: &T) -> u64 {
  let mut hasher = GxHasher::default();
  value.hash(&mut hasher);
  hasher.finish()
}

impl<T> AsRef<T> for Interned<T> {
  fn as_ref(&self) -> &T {
    &self.0.data
  }
}

impl<T> Deref for Interned<T> {
  type Target = T;

  fn deref(&self) -> &Self::Target {
    &self.0.data
  }
}

impl<T: Debug> Debug for Interned<T> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.0.data.fmt(f)
  }
}

impl<T: Display> Display for Interned<T> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.0.data.fmt(f)
  }
}

impl<T: PartialEq> PartialEq for Interned<T> {
  fn eq(&self, other: &Self) -> bool {
    // Interned values always point to unique values, so we only need to compare the pointers.
    std::ptr::eq(self.0, other.0)
  }
}

impl<T: Eq> Eq for Interned<T> {}

impl<T: PartialOrd> PartialOrd for Interned<T> {
  fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
    // If the pointers are equal, we know the values are also equal.
    if std::ptr::eq(self.0, other.0) {
      Some(std::cmp::Ordering::Equal)
    } else {
      self.0.data.partial_cmp(&other.0.data)
    }
  }
}

impl<T> Hash for Interned<T> {
  fn hash<H: Hasher>(&self, state: &mut H) {
    state.write_u64(self.0.hash);
  }
}

// When serialized, interned values are deduplicated.
// This is done by storing a (type erased) pointer in a map when serializing,
// and returning a reference to that value when serializing a second time.
struct Erased;
scoped_thread_local!(static SER_MAP: DashMap<*const Erased, u32, BuildHasherDefault<IdentityHasher>>);
scoped_thread_local!(static DE_MAP: DashMap<usize, *const Erased, BuildHasherDefault<IdentityHasher>>);

pub fn serialize_intern<R, F: FnOnce() -> R>(f: F) -> R {
  SER_MAP.set(&DashMap::default(), f)
}

pub fn deserialize_intern<R, F: FnOnce() -> R>(f: F) -> R {
  DE_MAP.set(&DashMap::default(), f)
}

#[derive(Serialize, Deserialize)]
enum Serialized<T: 'static> {
  Value(T),
  Reference(u32),
}

impl<T: Serialize + Debug + Clone> Serialize for Interned<T> {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    if serializer.is_human_readable() {
      self.0.data.serialize(serializer)
    } else {
      let ptr = self.0 as *const Entry<T> as *const Erased;
      SER_MAP.with(|map| {
        if let Some(idx) = map.get(&ptr) {
          let v: Serialized<T> = Serialized::Reference(*idx as u32);
          v.serialize(serializer)
        } else {
          let v = Serialized::Value(&self.0.data);
          let res = v.serialize(serializer);
          map.insert(ptr, map.len() as u32);
          res
        }
      })
    }
  }
}

impl<'de, T: Debug + Deserialize<'de> + Into<Interned<T>>> Deserialize<'de> for Interned<T> {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    if deserializer.is_human_readable() {
      let v: T = Deserialize::deserialize(deserializer)?;
      Ok(v.into())
    } else {
      let s: Serialized<T> = Serialized::deserialize(deserializer)?;
      DE_MAP.with(|map| match s {
        Serialized::Value(v) => {
          let interned = v.into();
          map.insert(map.len(), interned.0 as *const Entry<T> as *const Erased);
          Ok(interned)
        }
        Serialized::Reference(idx) => {
          let ptr = map.get(&(idx as usize)).unwrap();
          Ok(Interned(unsafe { &*(*ptr as *const Entry<T>) }))
        }
      })
    }
  }
}

impl<T> Clone for Interned<T> {
  fn clone(&self) -> Self {
    Interned(self.0)
  }
}

impl<T> Copy for Interned<T> {}

impl<T> Interned<T> {
  pub fn data(value: &Self) -> &'static T {
    &value.0.data
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

/// A HashSet that stores Interned values and uses their pre-computed hashes for efficiency.
pub type InternedSet<T> = HashSet<Interned<T>, BuildHasherDefault<IdentityHasher>>;
pub type InternedMap<K, V> = HashMap<Interned<K>, V, BuildHasherDefault<IdentityHasher>>;

fn string_interner() -> &'static Interner<String> {
  static INTERNER: OnceLock<Interner<String>> = OnceLock::new();
  INTERNER.get_or_init(|| Interner::new())
}

impl From<String> for Interned<String> {
  fn from(value: String) -> Self {
    string_interner().intern(value)
  }
}

impl From<&str> for Interned<String> {
  fn from(value: &str) -> Self {
    string_interner().intern(value.to_owned())
  }
}

impl PartialEq<&str> for Interned<String> {
  fn eq(&self, other: &&str) -> bool {
    self.0.data == *other
  }
}

fn path_interner() -> &'static Interner<PathBuf> {
  static INTERNER: OnceLock<Interner<PathBuf>> = OnceLock::new();
  INTERNER.get_or_init(|| Interner::new())
}

impl From<PathBuf> for Interned<PathBuf> {
  fn from(value: PathBuf) -> Self {
    path_interner().intern(value)
  }
}

impl From<&Path> for Interned<PathBuf> {
  fn from(value: &Path) -> Self {
    path_interner().intern(value.to_owned())
  }
}

impl From<&str> for Interned<PathBuf> {
  fn from(value: &str) -> Self {
    path_interner().intern(value.into())
  }
}

impl From<String> for Interned<PathBuf> {
  fn from(value: String) -> Self {
    path_interner().intern(value.into())
  }
}

impl PartialEq<&Path> for Interned<PathBuf> {
  fn eq(&self, other: &&Path) -> bool {
    self.0.data == *other
  }
}

#[cfg(test)]
mod tests {
  use crate::intern::{deserialize_intern, serialize_intern};

  use super::Interned;

  #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq)]
  struct Test {
    a: Interned<String>,
    b: Interned<String>,
  }

  #[test]
  fn test_serde() {
    let test = Test {
      a: "foo".into(),
      b: "foo".into(),
    };

    let mut serialized = Vec::new();
    serialize_intern(|| bincode::serialize_into(&mut serialized, &test).unwrap());
    assert_eq!(serialized.len(), 23);

    let deserialized: Test = deserialize_intern(|| bincode::deserialize(&serialized).unwrap());
    assert_eq!(deserialized, test);
  }
}
