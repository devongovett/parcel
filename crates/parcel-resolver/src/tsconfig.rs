use std::{
  borrow::Cow,
  path::{Path, PathBuf},
};

use crate::json_comments_rs::strip_comments_in_place;
use indexmap::IndexMap;
use itertools::Either;

use crate::{
  cache::{Cache, CachedPath},
  error::JsonError,
  specifier::Specifier,
  ResolverError,
};

#[derive(serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct SerializedTsConfig {
  base_url: Option<PathBuf>,
  paths: Option<IndexMap<Specifier<'static>, Vec<String>>>,
  pub module_suffixes: Option<Vec<String>>,
  // rootDirs??
}

pub struct TsConfig {
  pub path: CachedPath,
  base_url: Option<CachedPath>,
  paths: Option<IndexMap<Specifier<'static>, Vec<String>>>,
  paths_base: CachedPath,
  pub module_suffixes: Option<Vec<String>>,
}

fn deserialize_extends<'de, D>(deserializer: D) -> Result<Vec<Specifier<'static>>, D::Error>
where
  D: serde::Deserializer<'de>,
{
  use serde::Deserialize;

  #[derive(serde::Deserialize)]
  #[serde(untagged)]
  enum StringOrArray {
    String(Specifier<'static>),
    Array(Vec<Specifier<'static>>),
  }

  Ok(match StringOrArray::deserialize(deserializer)? {
    StringOrArray::String(s) => vec![s],
    StringOrArray::Array(a) => a,
  })
}

#[derive(serde::Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
struct SerializedTsConfigWrapper {
  #[serde(default, deserialize_with = "deserialize_extends")]
  pub extends: Vec<Specifier<'static>>,
  #[serde(default)]
  pub compiler_options: SerializedTsConfig,
}

pub struct TsConfigWrapper {
  pub extends: Vec<Specifier<'static>>,
  pub compiler_options: TsConfig,
}

impl TsConfig {
  pub fn read<F: FnOnce(&mut TsConfigWrapper) -> Result<(), ResolverError>>(
    path: &CachedPath,
    process: F,
    cache: &Cache,
  ) -> Result<TsConfigWrapper, ResolverError> {
    let data = cache.fs.read_to_string(path.as_path())?;
    let mut tsconfig = TsConfig::parse(path.clone(), data, &cache)
      .map_err(|e| JsonError::new(path.as_path().to_owned(), e))?;
    process(&mut tsconfig)?;
    Ok(tsconfig)
  }

  pub fn parse(
    path: CachedPath,
    mut data: String,
    cache: &Cache,
  ) -> serde_json::Result<TsConfigWrapper> {
    let _ = strip_comments_in_place(data.as_mut_str(), Default::default(), true);
    let wrapper: SerializedTsConfigWrapper = serde_json::from_str(&data)?;
    Ok(TsConfigWrapper {
      extends: wrapper.extends,
      compiler_options: TsConfig::from_serialized(path, wrapper.compiler_options, cache),
    })
  }

  fn from_serialized(path: CachedPath, serialized: SerializedTsConfig, cache: &Cache) -> TsConfig {
    let base_url = serialized
      .base_url
      .map(|base_url| path.resolve(&base_url, cache));

    TsConfig {
      paths_base: if serialized.paths.is_some() {
        base_url
          .clone()
          .unwrap_or_else(|| path.parent().unwrap().clone())
      } else {
        cache.get(Path::new(""))
      },
      path,
      base_url,
      paths: serialized.paths,
      module_suffixes: serialized.module_suffixes,
    }
  }

  pub fn extend(&mut self, extended: &TsConfig) {
    if self.base_url.is_none() {
      self.base_url = extended.base_url.clone();
    }

    if self.paths.is_none() {
      self.paths_base = extended.paths_base.clone();
      self.paths = extended.paths.clone();
    }

    if self.module_suffixes.is_none() {
      self.module_suffixes = extended.module_suffixes.clone();
    }
  }

  pub fn paths<'a>(
    &'a self,
    specifier: &'a Specifier,
    cache: &'a Cache,
  ) -> impl Iterator<Item = CachedPath> + 'a {
    if !matches!(specifier, Specifier::Package(..) | Specifier::Builtin(..)) {
      return Either::Right(Either::Right(std::iter::empty()));
    }

    // If there is a base url setting, resolve it relative to the tsconfig.json file.
    // Otherwise, the base for paths is implicitly the directory containing the tsconfig.
    let base_url_iter = if let Some(base_url) = &self.base_url {
      Either::Left(base_url_iter(base_url, specifier, cache))
    } else {
      Either::Right(std::iter::empty())
    };

    if let Some(paths) = &self.paths {
      // Check exact match first.
      if let Some(paths) = paths.get(specifier) {
        return Either::Left(join_paths(&self.paths_base, paths, None, cache).chain(base_url_iter));
      }

      // Check patterns
      let mut longest_prefix_length = 0;
      let mut longest_suffix_length = 0;
      let mut best_key = None;
      let full_specifier = specifier.to_string();

      for key in paths.keys() {
        let path = key.to_string();
        if let Some((prefix, suffix)) = path.split_once('*') {
          if (best_key.is_none() || prefix.len() > longest_prefix_length)
            && full_specifier.starts_with(prefix)
            && full_specifier.ends_with(suffix)
          {
            longest_prefix_length = prefix.len();
            longest_suffix_length = suffix.len();
            best_key = Some(key);
          }
        }
      }

      if let Some(key) = best_key {
        let paths = paths.get(key).unwrap();
        return Either::Left(
          join_paths(
            &self.paths_base,
            paths,
            Some((full_specifier, longest_prefix_length, longest_suffix_length)),
            cache,
          )
          .chain(base_url_iter),
        );
      }
    }

    if matches!(specifier, Specifier::Builtin(..)) {
      // If specifier is a builtin then there's no match
      return Either::Right(Either::Right(std::iter::empty()));
    }

    // If no paths were found, try relative to the base url.
    Either::Right(base_url_iter)
  }
}

fn join_paths<'a>(
  base_url: &'a CachedPath,
  paths: &'a [String],
  replacement: Option<(Cow<'a, str>, usize, usize)>,
  cache: &'a Cache,
) -> impl Iterator<Item = CachedPath> + 'a {
  paths
    .iter()
    .filter(|p| !p.ends_with(".d.ts"))
    .map(move |path| {
      if let Some((replacement, start, end)) = &replacement {
        let path = path.replace('*', &replacement[*start..replacement.len() - *end]);
        base_url.join(&path, cache)
      } else {
        base_url.join(path, cache)
      }
    })
}

fn base_url_iter<'a>(
  base_url: &'a CachedPath,
  specifier: &'a Specifier,
  cache: &'a Cache,
) -> impl Iterator<Item = CachedPath> + 'a {
  std::iter::once_with(move || {
    if let Specifier::Package(module, subpath) = specifier {
      base_url.join_package(module, subpath, cache)
    } else {
      base_url.clone()
    }
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use indexmap::indexmap;

  #[test]
  fn test_paths() {
    let cache = Cache::default();
    let tsconfig = TsConfig::from_serialized(
      cache.get_normalized("/foo/tsconfig.json"),
      SerializedTsConfig {
        base_url: None,
        paths: Some(indexmap! {
          "jquery".into() => vec!["node_modules/jquery/dist/jquery".into()],
          "*".into() => vec!["generated/*".into()],
          "bar/*".into() => vec!["test/*".into()],
          "bar/baz/*".into() => vec!["baz/*".into(), "yo/*".into()],
          "@/components/*".into() => vec!["components/*".into()],
          "url".into() => vec!["node_modules/my-url".into()],
        }),
        module_suffixes: None,
      },
      &cache,
    );

    let test = |specifier: &str| {
      tsconfig
        .paths(&specifier.into(), &cache)
        .collect::<Vec<CachedPath>>()
    };

    assert_eq!(
      test("jquery"),
      vec![cache.get_normalized("/foo/node_modules/jquery/dist/jquery")]
    );
    assert_eq!(
      test("test"),
      vec![cache.get_normalized("/foo/generated/test")]
    );
    assert_eq!(
      test("test/hello"),
      vec![cache.get_normalized("/foo/generated/test/hello")]
    );
    assert_eq!(test("bar/hi"), vec![cache.get_normalized("/foo/test/hi")]);
    assert_eq!(
      test("bar/baz/hi"),
      vec![
        cache.get_normalized("/foo/baz/hi"),
        cache.get_normalized("/foo/yo/hi")
      ]
    );
    assert_eq!(
      test("@/components/button"),
      vec![cache.get_normalized("/foo/components/button")]
    );
    assert_eq!(test("./jquery"), Vec::<CachedPath>::new());
    assert_eq!(
      test("url"),
      vec![cache.get_normalized("/foo/node_modules/my-url")]
    );
  }

  #[test]
  fn test_base_url() {
    let cache = Cache::default();
    let tsconfig = TsConfig::from_serialized(
      cache.get_normalized("/foo/tsconfig.json"),
      SerializedTsConfig {
        base_url: Some(PathBuf::from("src")),
        paths: None,
        module_suffixes: None,
      },
      &cache,
    );

    let test = |specifier: &str| {
      tsconfig
        .paths(&specifier.into(), &cache)
        .collect::<Vec<CachedPath>>()
    };

    assert_eq!(test("foo"), vec![cache.get_normalized("/foo/src/foo/")]);
    assert_eq!(
      test("components/button"),
      vec![cache.get_normalized("/foo/src/components/button")]
    );
    assert_eq!(test("./jquery"), Vec::<CachedPath>::new());
  }

  #[test]
  fn test_paths_and_base_url() {
    let cache = Cache::default();
    let tsconfig = TsConfig::from_serialized(
      cache.get_normalized("/foo/tsconfig.json"),
      SerializedTsConfig {
        base_url: Some(Path::new("src").into()),
        paths: Some(indexmap! {
          "*".into() => vec!["generated/*".into()],
          "bar/*".into() => vec!["test/*".into()],
          "bar/baz/*".into() => vec!["baz/*".into(), "yo/*".into()],
          "@/components/*".into() => vec!["components/*".into()],
        }),
        module_suffixes: None,
      },
      &cache,
    );

    let test = |specifier: &str| {
      tsconfig
        .paths(&specifier.into(), &cache)
        .collect::<Vec<CachedPath>>()
    };

    assert_eq!(
      test("test"),
      vec![
        cache.get_normalized("/foo/src/generated/test"),
        cache.get_normalized("/foo/src/test/")
      ]
    );
    assert_eq!(
      test("test/hello"),
      vec![
        cache.get_normalized("/foo/src/generated/test/hello"),
        cache.get_normalized("/foo/src/test/hello")
      ]
    );
    assert_eq!(
      test("bar/hi"),
      vec![
        cache.get_normalized("/foo/src/test/hi"),
        cache.get_normalized("/foo/src/bar/hi")
      ]
    );
    assert_eq!(
      test("bar/baz/hi"),
      vec![
        cache.get_normalized("/foo/src/baz/hi"),
        cache.get_normalized("/foo/src/yo/hi"),
        cache.get_normalized("/foo/src/bar/baz/hi")
      ]
    );
    assert_eq!(
      test("@/components/button"),
      vec![
        cache.get_normalized("/foo/src/components/button"),
        cache.get_normalized("/foo/src/@/components/button")
      ]
    );
    assert_eq!(test("./jquery"), Vec::<CachedPath>::new());
  }
}
