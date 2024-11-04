#[cfg(not(target_arch = "wasm32"))]
use crate::fs::FileSystemRealPathCache;
#[cfg(not(target_arch = "wasm32"))]
use std::collections::VecDeque;
use std::path::{Component, Path, PathBuf};

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

  ret
}

pub fn resolve_path<A: AsRef<Path>, B: AsRef<Path>>(base: A, subpath: B) -> PathBuf {
  let subpath = subpath.as_ref();
  let mut components = subpath.components().peekable();
  if subpath.is_absolute() || matches!(components.peek(), Some(Component::Prefix(..))) {
    return subpath.to_path_buf();
  }

  let mut ret = base.as_ref().to_path_buf();
  ret.pop();
  for component in subpath.components() {
    match component {
      Component::Prefix(..) | Component::RootDir => unreachable!(),
      Component::CurDir => {}
      Component::ParentDir => {
        ret.pop();
      }
      Component::Normal(c) => {
        ret.push(c);
      }
    }
  }

  ret
}

#[cfg(not(target_arch = "wasm32"))]
/// A reimplementation of std::fs::canonicalize with intermediary caching.
pub fn canonicalize(path: &Path, cache: &FileSystemRealPathCache) -> std::io::Result<PathBuf> {
  let mut ret = PathBuf::new();
  let mut seen_links = 0;
  let mut queue = VecDeque::new();

  queue.push_back(path.to_path_buf());

  while let Some(cur_path) = queue.pop_front() {
    let mut components = cur_path.components();
    for component in &mut components {
      match component {
        Component::Prefix(c) => ret.push(c.as_os_str()),
        Component::RootDir => {
          ret.push(component.as_os_str());
        }
        Component::CurDir => {}
        Component::ParentDir => {
          ret.pop();
        }
        Component::Normal(c) => {
          ret.push(c);

          // First, check the cache for the path up to this point.
          let link = if let Some(cached) = cache.get(&ret) {
            if let Some(link) = &*cached {
              link.clone()
            } else {
              continue;
            }
          } else {
            let stat = std::fs::symlink_metadata(&ret)?;
            if !stat.is_symlink() {
              cache.insert(ret.clone(), None);
              continue;
            }

            let link = std::fs::read_link(&ret)?;
            cache.insert(ret.clone(), Some(link.clone()));
            link
          };

          seen_links += 1;
          if seen_links > 32 {
            return Err(std::io::Error::new(
              std::io::ErrorKind::NotFound,
              "Too many symlinks",
            ));
          }

          // If the link is absolute, replace the result path
          // with it, otherwise remove the last segment and
          // resolve the link components next.
          if link.is_absolute() {
            ret = PathBuf::new();
          } else {
            ret.pop();
          }

          let remaining = components.as_path();
          if !remaining.as_os_str().is_empty() {
            queue.push_front(remaining.to_path_buf());
          }
          queue.push_front(link);
          break;
        }
      }
    }
  }

  Ok(ret)
}

#[cfg(test)]
mod test {
  use super::*;
  use assert_fs::prelude::*;
  use dashmap::DashMap;

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
    dir.child("a/b/c").create_dir_all()?;
    dir.child("a/b/e").symlink_to_file("..")?;
    dir.child("a/d").symlink_to_file("..")?;
    dir.child("a/b/c/x.txt").write_str("")?;
    dir
      .child("a/link")
      .symlink_to_file(dir.child("a/b").path())?;

    let cache = DashMap::default();

    assert_eq!(
      canonicalize(dir.child("symlink").path(), &cache)?,
      canonicalize(dir.child("foo/bar.js").path(), &cache)?
    );
    assert_eq!(
      canonicalize(dir.child("foo/symlink").path(), &cache)?,
      canonicalize(dir.child("root.js").path(), &cache)?
    );
    assert_eq!(
      canonicalize(dir.child("absolute").path(), &cache)?,
      canonicalize(dir.child("root.js").path(), &cache)?
    );
    assert_eq!(
      canonicalize(dir.child("recursive").path(), &cache)?,
      canonicalize(dir.child("root.js").path(), &cache)?
    );
    assert!(canonicalize(dir.child("cycle").path(), &cache).is_err());
    assert_eq!(
      canonicalize(dir.child("a/b/e/d/a/b/e/d/a").path(), &cache)?,
      canonicalize(dir.child("a").path(), &cache)?
    );
    assert_eq!(
      canonicalize(dir.child("a/link/c/x.txt").path(), &cache)?,
      canonicalize(dir.child("a/b/c/x.txt").path(), &cache)?
    );

    Ok(())
  }
}
