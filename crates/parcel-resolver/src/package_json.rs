use std::{
  borrow::Cow,
  cmp::Ordering,
  ops::Range,
  path::{Component, Path, PathBuf},
};

use bitflags::bitflags;
use glob_match::{glob_match, glob_match_with_captures};
use indexmap::IndexMap;
use serde::Deserialize;

use crate::{
  cache::{Cache, CachedPath},
  error::JsonError,
  specifier::{decode_path, Specifier, SpecifierType},
  ResolverError,
};

bitflags! {
  /// A package.json top-level entry field.
  #[derive(serde::Serialize)]
  pub struct Fields: u8 {
    /// The "main" field.
    const MAIN = 1 << 0;
    /// The "module" field.
    const MODULE = 1 << 1;
    /// The "source" field.
    const SOURCE = 1 << 2;
    /// The "browser" field.
    const BROWSER = 1 << 3;
    /// The "alias" field.
    const ALIAS = 1 << 4;
    /// The "tsconfig" field.
    const TSCONFIG = 1 << 5;
    /// The "types" field.
    const TYPES = 1 << 6;
  }
}

#[derive(serde::Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct SerializedPackageJson {
  #[serde(default, deserialize_with = "ok_or_default")]
  pub name: String,
  #[serde(rename = "type", default, deserialize_with = "ok_or_default")]
  pub module_type: ModuleType,
  #[serde(default, deserialize_with = "ok_or_default")]
  main: Option<PathBuf>,
  #[serde(default, deserialize_with = "ok_or_default")]
  module: Option<PathBuf>,
  #[serde(default, deserialize_with = "ok_or_default")]
  tsconfig: Option<PathBuf>,
  #[serde(default, deserialize_with = "ok_or_default")]
  types: Option<PathBuf>,
  #[serde(default, deserialize_with = "ok_or_default")]
  pub source: SourceField,
  #[serde(default, deserialize_with = "ok_or_default")]
  browser: BrowserField,
  #[serde(default, deserialize_with = "ok_or_default")]
  alias: IndexMap<Specifier<'static>, AliasValue<'static>>,
  #[serde(default, deserialize_with = "ok_or_default")]
  exports: ExportsField,
  #[serde(default, deserialize_with = "ok_or_default")]
  imports: IndexMap<ExportsKey<'static>, ExportsField>,
  #[serde(default, deserialize_with = "ok_or_default")]
  side_effects: SideEffects,
}

fn ok_or_default<'de, T, D>(deserializer: D) -> Result<T, D::Error>
where
  T: serde::Deserialize<'de> + Default,
  D: serde::Deserializer<'de>,
{
  Ok(T::deserialize(deserializer).unwrap_or_default())
}

#[derive(Debug)]
pub struct PackageJson {
  pub path: CachedPath,
  pub name: String,
  pub module_type: ModuleType,
  main: Option<CachedPath>,
  module: Option<CachedPath>,
  tsconfig: Option<CachedPath>,
  types: Option<CachedPath>,
  pub source: SourceField,
  browser: BrowserField,
  alias: IndexMap<Specifier<'static>, AliasValue<'static>>,
  exports: ExportsField,
  imports: IndexMap<ExportsKey<'static>, ExportsField>,
  side_effects: SideEffects,
}

/// Whether the module is ESM, CommonJS, or JSON according to its extension or the package.json "type" field.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ModuleType {
  Module,
  Json,
  #[default]
  #[serde(other)]
  CommonJs,
}

#[derive(serde::Deserialize, Debug, Default)]
#[serde(untagged)]
pub enum BrowserField {
  #[default]
  None,
  String(String),
  Map(IndexMap<Specifier<'static>, AliasValue<'static>>),
}

#[derive(serde::Deserialize, Debug, Default)]
#[serde(untagged)]
pub enum SourceField {
  #[default]
  None,
  String(String),
  Map(IndexMap<Specifier<'static>, AliasValue<'static>>),
  Array(Vec<String>),
  Bool(bool),
}

#[derive(serde::Deserialize, Debug, Default, PartialEq)]
#[serde(untagged)]
pub enum ExportsField {
  #[default]
  None,
  String(String),
  #[serde(skip)]
  Path(CachedPath),
  Array(Vec<ExportsField>),
  Map(IndexMap<ExportsKey<'static>, ExportsField>),
}

impl ExportsField {
  fn convert_paths<F: FnMut() -> bool>(
    &mut self,
    base: &CachedPath,
    cache: &Cache,
    is_source: &mut F,
  ) {
    match self {
      ExportsField::String(target) => {
        if target.starts_with("./") && !target.contains('*') {
          // If target split on "/" or "\" contains any "", ".", "..", or "node_modules" segments after
          // the first "." segment, case insensitive and including percent encoded variants,
          // throw an Invalid Package Target error.
          let target_path = decode_path(target.as_ref(), SpecifierType::Esm).0;
          if target_path
            .components()
            .enumerate()
            .any(|(index, c)| match c {
              Component::ParentDir => true,
              Component::CurDir => index > 0,
              Component::Normal(c) => c.eq_ignore_ascii_case("node_modules"),
              _ => false,
            })
          {
            return;
          }

          *self = ExportsField::Path(base.resolve(&target_path, cache));
        }
      }
      ExportsField::Array(arr) => {
        for item in arr {
          item.convert_paths(base, cache, is_source);
        }
      }
      ExportsField::Map(map) => {
        for (key, val) in map.iter_mut() {
          if matches!(key, ExportsKey::Condition(ExportsCondition::SOURCE)) && !is_source() {
            *val = ExportsField::None;
          } else {
            val.convert_paths(base, cache, is_source);
          }
        }
      }
      _ => {}
    }
  }
}

bitflags! {
  /// A common package.json "exports" field.
  pub struct ExportsCondition: u32 {
    /// The "import" condition. True when the package was referenced using the ESM `import` syntax.
    const IMPORT = 1 << 0;
    /// The "require" condition. True when the package was referenced using the CommonJS `require` function.
    const REQUIRE = 1 << 1;
    /// The "module" condition. True when the package was referenced from either the ESM `import` syntax or the CommonJS `require` function/
    const MODULE = 1 << 2;
    /// The "node" condition. True when the module will run in a Node environment.
    const NODE = 1 << 3;
    /// The "browser" condition. True when the module will run in a browser environment.
    const BROWSER = 1 << 4;
    /// The "worker" condition. True when the module will run in a web worker or service worker environment.
    const WORKER = 1 << 5;
    /// The "worklet" condition. True when the module will run in a worklet environment.
    const WORKLET = 1 << 6;
    /// The "electron" condition. True when the module will run in an Electron environment.
    const ELECTRON = 1 << 7;
    /// The "development" condition. True when the module will run in a development environment.
    const DEVELOPMENT = 1 << 8;
    /// The "production" condition. True when the module will run in a production environment.
    const PRODUCTION = 1 << 9;
    /// The "types" condition. True when loading TypeScript types.
    const TYPES = 1 << 10;
    /// The "default" condition when no other conditions matched.
    const DEFAULT = 1 << 11;
    /// The "style" condition. True when the package was referenced from a stylesheet (e.g. CSS, Sass, Stylus, etc.).
    const STYLE = 1 << 12;
    /// The "sass" condition. True when the package was referenced from a Sass stylesheet.
    const SASS = 1 << 13;
    /// The "less" condition. True when the package was referenced from a Less stylesheet.
    const LESS = 1 << 14;
    /// The "stylus" condition. True when the package was referenced from a Stylus stylesheet.
    const STYLUS = 1 << 15;
    /// The "react-server" condition.
    const REACT_SERVER = 1 << 16;
    /// The "source" condition.
    const SOURCE = 1 << 17;
  }
}

impl Default for ExportsCondition {
  fn default() -> Self {
    ExportsCondition::empty()
  }
}

impl TryFrom<&str> for ExportsCondition {
  type Error = ();
  fn try_from(value: &str) -> Result<Self, Self::Error> {
    Ok(match value {
      "import" => ExportsCondition::IMPORT,
      "require" => ExportsCondition::REQUIRE,
      "module" => ExportsCondition::MODULE,
      "node" => ExportsCondition::NODE,
      "browser" => ExportsCondition::BROWSER,
      "worker" => ExportsCondition::WORKER,
      "worklet" => ExportsCondition::WORKLET,
      "electron" => ExportsCondition::ELECTRON,
      "development" => ExportsCondition::DEVELOPMENT,
      "production" => ExportsCondition::PRODUCTION,
      "types" => ExportsCondition::TYPES,
      "default" => ExportsCondition::DEFAULT,
      "style" => ExportsCondition::STYLE,
      "sass" => ExportsCondition::SASS,
      "less" => ExportsCondition::LESS,
      "stylus" => ExportsCondition::STYLUS,
      "react-server" => ExportsCondition::REACT_SERVER,
      "source" => ExportsCondition::SOURCE,
      _ => return Err(()),
    })
  }
}

#[derive(Debug, PartialEq, Eq, Hash)]
pub enum ExportsKey<'a> {
  Main,
  Pattern(Cow<'a, str>),
  Condition(ExportsCondition),
  CustomCondition(String),
}

impl<'a> From<&str> for ExportsKey<'a> {
  fn from(key: &str) -> Self {
    if key == "." {
      ExportsKey::Main
    } else if let Some(key) = key.strip_prefix("./") {
      ExportsKey::Pattern(Cow::Owned(key.to_owned()))
    } else if let Some(key) = key.strip_prefix('#') {
      ExportsKey::Pattern(Cow::Owned(key.to_owned()))
    } else if let Ok(c) = ExportsCondition::try_from(key) {
      ExportsKey::Condition(c)
    } else {
      ExportsKey::CustomCondition(key.to_owned())
    }
  }
}

impl<'de> Deserialize<'de> for ExportsKey<'static> {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    let s: &'de str = Deserialize::deserialize(deserializer)?;
    Ok(ExportsKey::from(s))
  }
}

#[derive(serde::Deserialize, Clone, PartialEq, Debug)]
#[serde(untagged)]
pub enum AliasValue<'a> {
  #[serde(bound(deserialize = "'a: 'static"))]
  Specifier(Specifier<'a>),
  Bool(bool),
  Global {
    global: String,
  },
}

#[derive(serde::Deserialize, Clone, Default, PartialEq, Debug)]
#[serde(untagged)]
pub enum SideEffects {
  #[default]
  None,
  Boolean(bool),
  String(String),
  Array(Vec<String>),
}

/// An error that occurred in a package.json.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub enum PackageJsonError {
  /// An invalid package.json "exports" or "imports" target.
  InvalidPackageTarget,
  /// The requested subpath of a package.json was not exported.
  PackagePathNotExported,
  /// An invalid specifier was requested.
  InvalidSpecifier,
  /// A package import was not defined.
  ImportNotDefined,
}

#[derive(Debug, PartialEq)]
pub enum ExportsResolution<'a> {
  None,
  Path(CachedPath),
  Package(Cow<'a, str>),
}

impl PackageJson {
  pub fn read(path: &CachedPath, cache: &Cache) -> Result<PackageJson, ResolverError> {
    let contents = cache.fs.read_to_string(path.as_path())?;
    let pkg = PackageJson::parse(path.clone(), contents, cache)
      .map_err(|e| JsonError::new(path.as_path().into(), e))?;
    Ok(pkg)
  }

  pub fn parse(path: CachedPath, data: String, cache: &Cache) -> serde_json::Result<PackageJson> {
    let parsed: SerializedPackageJson = serde_json::from_str(&data)?;
    Ok(PackageJson::from_serialized(path, parsed, cache))
  }

  fn from_serialized(
    path: CachedPath,
    mut parsed: SerializedPackageJson,
    cache: &Cache,
  ) -> PackageJson {
    // If the package has a `source` field, make sure
    // - the package is behind symlinks
    // - and the realpath to the packages does not includes `node_modules`.
    // Since such package is likely a pre-compiled module
    // installed with package managers, rather than including a source code.
    let mut is_source = None;

    let mut check_in_source = || {
      if let Some(is_source) = is_source {
        return is_source;
      }

      if let Ok(realpath) = path.canonicalize(&cache) {
        let is_src = realpath != path && !realpath.in_node_modules();
        is_source = Some(is_src);
        is_src
      } else {
        is_source = Some(false);
        false
      }
    };

    if !matches!(parsed.source, SourceField::None) {
      if !check_in_source() {
        parsed.source = SourceField::None;
      }
    }

    parsed
      .exports
      .convert_paths(&path, cache, &mut check_in_source);

    PackageJson {
      name: parsed.name,
      module_type: parsed.module_type,
      main: parsed.main.map(|main| path.resolve(&main, cache)),
      module: parsed.module.map(|module| path.resolve(&module, cache)),
      tsconfig: parsed
        .tsconfig
        .map(|tsconfig| path.resolve(&tsconfig, cache)),
      types: parsed.types.map(|types| path.resolve(&types, cache)),
      source: parsed.source,
      browser: parsed.browser,
      alias: parsed.alias,
      exports: parsed.exports,
      imports: parsed.imports,
      side_effects: parsed.side_effects,
      path,
    }
  }

  pub fn entries<'a>(&'a self, fields: Fields, cache: &'a Cache) -> EntryIter {
    EntryIter {
      package: self,
      fields,
      cache,
    }
  }

  pub fn source(&self, cache: &Cache) -> Option<CachedPath> {
    match &self.source {
      SourceField::None | SourceField::Array(_) | SourceField::Bool(_) => None,
      SourceField::String(source) => Some(self.path.resolve(Path::new(source), cache)),
      SourceField::Map(map) => match map.get(&Specifier::Package(
        Cow::Borrowed(self.name.as_str()),
        Cow::Borrowed(""),
      )) {
        Some(AliasValue::Specifier(Specifier::Relative(s))) => Some(self.path.resolve(s, cache)),
        _ => None,
      },
    }
  }

  pub fn has_exports(&self) -> bool {
    self.exports != ExportsField::None
  }

  pub fn resolve_package_exports(
    &self,
    subpath: &str,
    conditions: ExportsCondition,
    custom_conditions: &[String],
    paths: &Cache,
  ) -> Result<CachedPath, PackageJsonError> {
    // If exports is an Object with both a key starting with "." and a key not starting with ".", throw an Invalid Package Configuration error.
    if let ExportsField::Map(map) = &self.exports {
      let mut has_conditions = false;
      let mut has_patterns = false;
      for key in map.keys() {
        has_conditions = has_conditions
          || matches!(
            key,
            ExportsKey::Condition(..) | ExportsKey::CustomCondition(..)
          );
        has_patterns = has_patterns || matches!(key, ExportsKey::Pattern(..) | ExportsKey::Main);
        if has_conditions && has_patterns {
          return Err(PackageJsonError::InvalidPackageTarget);
        }
      }
    }

    if subpath.is_empty() {
      let mut main_export = &ExportsField::None;
      match &self.exports {
        ExportsField::None
        | ExportsField::String(_)
        | ExportsField::Path(_)
        | ExportsField::Array(_) => {
          main_export = &self.exports;
        }
        ExportsField::Map(map) => {
          if let Some(v) = map.get(&ExportsKey::Main) {
            main_export = v;
          } else if !map.keys().any(|k| matches!(k, ExportsKey::Pattern(_))) {
            main_export = &self.exports;
          }
        }
      }

      if main_export != &ExportsField::None {
        match self.resolve_package_target(
          main_export,
          "",
          false,
          conditions,
          custom_conditions,
          paths,
        )? {
          ExportsResolution::Path(path) => return Ok(path),
          ExportsResolution::None | ExportsResolution::Package(..) => {}
        }
      }
    } else if let ExportsField::Map(exports) = &self.exports {
      // All exports must start with "." at this point.
      match self.resolve_package_imports_exports(
        subpath,
        exports,
        false,
        conditions,
        custom_conditions,
        paths,
      )? {
        ExportsResolution::Path(path) => return Ok(path),
        ExportsResolution::None | ExportsResolution::Package(..) => {}
      }
    }

    Err(PackageJsonError::PackagePathNotExported)
  }

  pub fn resolve_package_imports<'a>(
    &'a self,
    specifier: &'a str,
    conditions: ExportsCondition,
    custom_conditions: &[String],
    paths: &Cache,
  ) -> Result<ExportsResolution<'a>, PackageJsonError> {
    if specifier == "#" || specifier.starts_with("#/") {
      return Err(PackageJsonError::InvalidSpecifier);
    }

    match self.resolve_package_imports_exports(
      specifier,
      &self.imports,
      true,
      conditions,
      custom_conditions,
      paths,
    )? {
      ExportsResolution::None => {}
      res => return Ok(res),
    }

    Err(PackageJsonError::ImportNotDefined)
  }

  fn resolve_package_target<'a>(
    &'a self,
    target: &'a ExportsField,
    pattern_match: &str,
    is_imports: bool,
    conditions: ExportsCondition,
    custom_conditions: &[String],
    paths: &Cache,
  ) -> Result<ExportsResolution<'_>, PackageJsonError> {
    match target {
      ExportsField::String(target) => {
        if !target.starts_with("./") {
          if !is_imports || target.starts_with("../") || target.starts_with('/') {
            return Err(PackageJsonError::InvalidPackageTarget);
          }

          if !pattern_match.is_empty() {
            let target = target.replace('*', pattern_match);
            return Ok(ExportsResolution::Package(Cow::Owned(target)));
          }

          return Ok(ExportsResolution::Package(Cow::Borrowed(target)));
        }

        let target = if pattern_match.is_empty() {
          Cow::Borrowed(target.as_str())
        } else {
          Cow::Owned(target.replace('*', pattern_match))
        };

        // If target split on "/" or "\" contains any "", ".", "..", or "node_modules" segments after
        // the first "." segment, case insensitive and including percent encoded variants,
        // throw an Invalid Package Target error.
        let target_path = decode_path(target.as_ref(), SpecifierType::Esm).0;
        if target_path
          .components()
          .enumerate()
          .any(|(index, c)| match c {
            Component::ParentDir => true,
            Component::CurDir => index > 0,
            Component::Normal(c) => c.eq_ignore_ascii_case("node_modules"),
            _ => false,
          })
        {
          return Err(PackageJsonError::InvalidPackageTarget);
        }

        let resolved_target = self.path.resolve(&target_path, paths);
        return Ok(ExportsResolution::Path(resolved_target));
      }
      ExportsField::Path(target) => return Ok(ExportsResolution::Path(target.clone())),
      ExportsField::Map(target) => {
        // We must iterate in object insertion order.
        for (key, value) in target {
          let matches = match key {
            ExportsKey::Condition(key) => {
              *key == ExportsCondition::DEFAULT || conditions.contains(*key)
            }
            ExportsKey::CustomCondition(key) => custom_conditions.iter().any(|k| k == key),
            _ => false,
          };
          if matches {
            match self.resolve_package_target(
              value,
              pattern_match,
              is_imports,
              conditions,
              custom_conditions,
              paths,
            )? {
              ExportsResolution::None => continue,
              res => return Ok(res),
            }
          }
        }
      }
      ExportsField::Array(target) => {
        if target.is_empty() {
          return Err(PackageJsonError::PackagePathNotExported);
        }

        for item in target {
          match self.resolve_package_target(
            item,
            pattern_match,
            is_imports,
            conditions,
            custom_conditions,
            paths,
          ) {
            Err(_) | Ok(ExportsResolution::None) => continue,
            Ok(res) => return Ok(res),
          }
        }
      }
      ExportsField::None => return Ok(ExportsResolution::None),
    }

    Ok(ExportsResolution::None)
  }

  fn resolve_package_imports_exports<'a>(
    &'a self,
    match_key: &'a str,
    match_obj: &'a IndexMap<ExportsKey, ExportsField>,
    is_imports: bool,
    conditions: ExportsCondition,
    custom_conditions: &[String],
    paths: &Cache,
  ) -> Result<ExportsResolution<'_>, PackageJsonError> {
    let pattern = ExportsKey::Pattern(Cow::Borrowed(match_key));
    if let Some(target) = match_obj.get(&pattern) {
      if !match_key.contains('*') {
        return self.resolve_package_target(
          target,
          "",
          is_imports,
          conditions,
          custom_conditions,
          paths,
        );
      }
    }

    let mut best_key = "";
    let mut best_match = "";
    for key in match_obj.keys() {
      if let ExportsKey::Pattern(key) = key {
        if let Some((pattern_base, pattern_trailer)) = key.split_once('*') {
          if match_key.starts_with(pattern_base)
            && !pattern_trailer.contains('*')
            && (pattern_trailer.is_empty()
              || (match_key.len() >= key.len() && match_key.ends_with(pattern_trailer)))
            && pattern_key_compare(best_key, key) == Ordering::Greater
          {
            best_key = key;
            best_match = &match_key[pattern_base.len()..match_key.len() - pattern_trailer.len()];
          }
        }
      }
    }

    if !best_key.is_empty() {
      return self.resolve_package_target(
        &match_obj[&ExportsKey::Pattern(Cow::Borrowed(best_key))],
        best_match,
        is_imports,
        conditions,
        custom_conditions,
        paths,
      );
    }

    Ok(ExportsResolution::None)
  }

  pub fn resolve_aliases<'a>(
    &'a self,
    specifier: &Specifier<'a>,
    fields: Fields,
  ) -> Option<Cow<'a, AliasValue<'a>>> {
    if fields.contains(Fields::SOURCE) {
      if let SourceField::Map(source) = &self.source {
        match self.resolve_alias(source, specifier) {
          None => {}
          res => return res,
        }
      }
    }

    if fields.contains(Fields::ALIAS) {
      match self.resolve_alias(&self.alias, specifier) {
        None => {}
        res => return res,
      }
    }

    if fields.contains(Fields::BROWSER) {
      if let BrowserField::Map(browser) = &self.browser {
        match self.resolve_alias(browser, specifier) {
          None => {}
          res => return res,
        }
      }
    }

    None
  }

  fn resolve_alias<'a>(
    &'a self,
    map: &'a IndexMap<Specifier<'a>, AliasValue<'a>>,
    specifier: &Specifier<'a>,
  ) -> Option<Cow<'a, AliasValue>> {
    if let Some(alias) = self.lookup_alias(map, specifier) {
      return Some(alias);
    }

    if let Specifier::Package(package, subpath) = specifier {
      if let Some(alias) =
        self.lookup_alias(map, &Specifier::Package(package.clone(), Cow::Borrowed("")))
      {
        match alias.as_ref() {
          AliasValue::Specifier(base) => {
            // Join the subpath back onto the resolved alias.
            match base {
              Specifier::Package(base_pkg, base_subpath) => {
                let subpath = if !base_subpath.is_empty() && !subpath.is_empty() {
                  let mut full_subpath =
                    String::with_capacity(base_subpath.len() + subpath.len() + 1);
                  full_subpath.push_str(base_subpath);
                  full_subpath.push('/');
                  full_subpath.push_str(subpath);
                  Cow::Owned(full_subpath)
                } else if !subpath.is_empty() {
                  subpath.clone()
                } else {
                  return Some(alias);
                };
                return Some(Cow::Owned(AliasValue::Specifier(Specifier::Package(
                  base_pkg.clone(),
                  subpath,
                ))));
              }
              Specifier::Relative(path) => {
                if subpath.is_empty() {
                  return Some(alias);
                } else {
                  return Some(Cow::Owned(AliasValue::Specifier(Specifier::Relative(
                    Cow::Owned(path.join(subpath.as_ref())),
                  ))));
                }
              }
              Specifier::Absolute(path) => {
                if subpath.is_empty() {
                  return Some(alias);
                } else {
                  return Some(Cow::Owned(AliasValue::Specifier(Specifier::Absolute(
                    Cow::Owned(path.join(subpath.as_ref())),
                  ))));
                }
              }
              Specifier::Tilde(path) => {
                if subpath.is_empty() {
                  return Some(alias);
                } else {
                  return Some(Cow::Owned(AliasValue::Specifier(Specifier::Tilde(
                    Cow::Owned(path.join(subpath.as_ref())),
                  ))));
                }
              }
              _ => return Some(alias),
            }
          }
          _ => return Some(alias),
        };
      }
    }

    None
  }

  fn lookup_alias<'a>(
    &'a self,
    map: &'a IndexMap<Specifier<'a>, AliasValue<'a>>,
    specifier: &Specifier<'a>,
  ) -> Option<Cow<'a, AliasValue>> {
    if let Some(value) = map.get(specifier) {
      return Some(Cow::Borrowed(value));
    }

    // Match glob aliases.
    for (key, value) in map {
      let (glob, path) = match (key, specifier) {
        (Specifier::Relative(glob), Specifier::Relative(path))
        | (Specifier::Absolute(glob), Specifier::Absolute(path))
        | (Specifier::Tilde(glob), Specifier::Tilde(path)) => (
          glob.as_os_str().to_string_lossy(),
          path.as_os_str().to_string_lossy(),
        ),
        (Specifier::Package(module_a, glob), Specifier::Package(module_b, path))
          if module_a == module_b =>
        {
          (Cow::Borrowed(glob.as_ref()), Cow::Borrowed(path.as_ref()))
        }
        (pkg_a @ Specifier::Package(..), pkg_b @ Specifier::Package(..)) => {
          // Glob could be in the package name, e.g. "@internal/*"
          (pkg_a.to_string(), pkg_b.to_string())
        }
        _ => continue,
      };

      if let Some(captures) = glob_match_with_captures(&glob, &path) {
        let res = match value {
          AliasValue::Specifier(specifier) => AliasValue::Specifier(match specifier {
            Specifier::Relative(r) => {
              Specifier::Relative(replace_path_captures(r, &path, &captures)?)
            }
            Specifier::Absolute(r) => {
              Specifier::Absolute(replace_path_captures(r, &path, &captures)?)
            }
            Specifier::Tilde(r) => Specifier::Tilde(replace_path_captures(r, &path, &captures)?),
            Specifier::Package(module, subpath) => {
              Specifier::Package(module.clone(), replace_captures(subpath, &path, &captures))
            }
            _ => return Some(Cow::Borrowed(value)),
          }),
          _ => return Some(Cow::Borrowed(value)),
        };

        return Some(Cow::Owned(res));
      }
    }

    None
  }

  pub fn has_side_effects(&self, path: &Path) -> bool {
    let path = path
      .strip_prefix(self.path.as_path().parent().unwrap())
      .ok()
      .and_then(|path| path.as_os_str().to_str());

    let path = match path {
      Some(p) => p,
      None => return true,
    };

    fn side_effects_glob_matches(glob: &str, path: &str) -> bool {
      // Trim leading "./"
      let glob = glob.strip_prefix("./").unwrap_or(glob);

      // If the glob does not contain any '/' characters, prefix with "**/" to match webpack.
      let glob = if !glob.contains('/') {
        Cow::Owned(format!("**/{}", glob))
      } else {
        Cow::Borrowed(glob)
      };

      glob_match(glob.as_ref(), path)
    }

    match &self.side_effects {
      SideEffects::None => true,
      SideEffects::Boolean(b) => *b,
      SideEffects::String(glob) => side_effects_glob_matches(glob, path),
      SideEffects::Array(globs) => globs
        .iter()
        .any(|glob| side_effects_glob_matches(glob, path)),
    }
  }
}

fn replace_path_captures<'a>(
  s: &'a Path,
  path: &str,
  captures: &Vec<Range<usize>>,
) -> Option<Cow<'a, Path>> {
  Some(
    match replace_captures(s.as_os_str().to_str()?, path, captures) {
      Cow::Borrowed(b) => Cow::Borrowed(Path::new(b)),
      Cow::Owned(b) => Cow::Owned(PathBuf::from(b)),
    },
  )
}

/// Inserts captures matched in a glob against `path` using a pattern string.
/// Replacements are inserted using JS-like $N syntax, e.g. $1 for the first capture.
fn replace_captures<'a>(s: &'a str, path: &str, captures: &Vec<Range<usize>>) -> Cow<'a, str> {
  let mut res = Cow::Borrowed(s);
  let bytes = s.as_bytes();
  for (idx, _) in s.match_indices('$').rev() {
    let mut end = idx;
    while end + 1 < bytes.len() && bytes[end + 1].is_ascii_digit() {
      end += 1;
    }

    if end != idx {
      if let Ok(capture_index) = s[idx + 1..end + 1].parse::<usize>() {
        if capture_index > 0 && capture_index - 1 < captures.len() {
          res
            .to_mut()
            .replace_range(idx..end + 1, &path[captures[capture_index - 1].clone()]);
        }
      }
    }
  }

  res
}

fn pattern_key_compare(a: &str, b: &str) -> Ordering {
  let a_pos = a.chars().position(|c| c == '*');
  let b_pos = b.chars().position(|c| c == '*');
  let base_length_a = a_pos.map_or(a.len(), |p| p + 1);
  let base_length_b = b_pos.map_or(b.len(), |p| p + 1);
  let cmp = base_length_b.cmp(&base_length_a);
  if cmp != Ordering::Equal {
    return cmp;
  }

  if a_pos.is_none() {
    return Ordering::Greater;
  }

  if b_pos.is_none() {
    return Ordering::Less;
  }

  b.len().cmp(&a.len())
}

pub struct EntryIter<'a> {
  package: &'a PackageJson,
  fields: Fields,
  cache: &'a Cache,
}

impl<'a> Iterator for EntryIter<'a> {
  type Item = (CachedPath, &'static str);

  fn next(&mut self) -> Option<Self::Item> {
    if self.fields.contains(Fields::SOURCE) {
      self.fields.remove(Fields::SOURCE);
      if let Some(source) = self.package.source(&self.cache) {
        return Some((source, "source"));
      }
    }

    if self.fields.contains(Fields::TYPES) {
      self.fields.remove(Fields::TYPES);
      if let Some(types) = &self.package.types {
        return Some((types.clone(), "types"));
      }
    }

    if self.fields.contains(Fields::BROWSER) {
      self.fields.remove(Fields::BROWSER);
      match &self.package.browser {
        BrowserField::None => {}
        BrowserField::String(browser) => {
          return Some((
            self.package.path.resolve(Path::new(browser), self.cache),
            "browser",
          ))
        }
        BrowserField::Map(map) => {
          if let Some(AliasValue::Specifier(Specifier::Relative(s))) = map.get(&Specifier::Package(
            Cow::Borrowed(&self.package.name),
            Cow::Borrowed(""),
          )) {
            return Some((self.package.path.resolve(s, self.cache), "browser"));
          }
        }
      }
    }

    if self.fields.contains(Fields::MODULE) {
      self.fields.remove(Fields::MODULE);
      if let Some(module) = &self.package.module {
        return Some((module.clone(), "module"));
      }
    }

    if self.fields.contains(Fields::MAIN) {
      self.fields.remove(Fields::MAIN);
      if let Some(main) = &self.package.main {
        return Some((main.clone(), "main"));
      }
    }

    if self.fields.contains(Fields::TSCONFIG) {
      self.fields.remove(Fields::TSCONFIG);
      if let Some(tsconfig) = &self.package.tsconfig {
        return Some((tsconfig.clone(), "tsconfig"));
      }
    }

    None
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use indexmap::indexmap;

  // Based on https://github.com/lukeed/resolve.exports/blob/master/test/resolve.js,
  // https://github.com/privatenumber/resolve-pkg-maps/tree/develop/tests, and
  // https://github.com/webpack/enhanced-resolve/blob/main/test/exportsField.js

  #[test]
  fn exports_string() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::String("./exports.js".into()),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/exports.js")
    );
    // assert_eq!(pkg.resolve_package_exports("./exports.js", &[]).unwrap(), cache.get_normalized("/foo/exports.js"), &cache);
    // assert_eq!(pkg.resolve_package_exports("foobar", &[]).unwrap(), cache.get_normalized("/foo/exports.js"), &cache);
  }

  #[test]
  fn exports_dot() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          ".".into() => ExportsField::String("./exports.js".into())
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/exports.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports(".", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
    // assert_eq!(pkg.resolve_package_exports("foobar", &[]).unwrap(), cache.get_normalized("/foo/exports.js"), &cache);
  }

  #[test]
  fn exports_dot_conditions() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          ".".into() => ExportsField::Map(indexmap! {
            "import".into() => ExportsField::String("./import.js".into()),
            "require".into() => ExportsField::String("./require.js".into())
          })
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports(
          "",
          ExportsCondition::IMPORT | ExportsCondition::REQUIRE,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/import.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::REQUIRE, &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/require.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports("", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("", ExportsCondition::NODE, &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
  }

  #[test]
  fn exports_map_string() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./foo".into() => ExportsField::String("./exports.js".into()),
          "./.invisible".into() => ExportsField::String("./.invisible.js".into()),
          "./".into() => ExportsField::String("./".into()),
          "./*".into() => ExportsField::String("./*.js".into())
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports("foo", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/exports.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(".invisible", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/.invisible.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("file", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/file.js")
    );
  }

  #[test]
  fn exports_map_conditions() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./foo".into() => ExportsField::Map(indexmap! {
            "import".into() => ExportsField::String("./import.js".into()),
            "require".into() => ExportsField::String("./require.js".into())
          })
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports(
          "foo",
          ExportsCondition::IMPORT | ExportsCondition::REQUIRE,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/import.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("foo", ExportsCondition::REQUIRE, &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/require.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports("foo", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("foo", ExportsCondition::NODE, &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
  }

  #[test]
  fn nested_conditions() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "node".into() => ExportsField::Map(indexmap! {
            "import".into() => ExportsField::String("./import.js".into()),
            "require".into() => ExportsField::String("./require.js".into())
          }),
          "default".into() => ExportsField::String("./default.js".into())
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports(
          "",
          ExportsCondition::NODE | ExportsCondition::IMPORT,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/import.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(
          "",
          ExportsCondition::NODE | ExportsCondition::REQUIRE,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/require.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::IMPORT, &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/default.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/default.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::NODE, &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/default.js")
    );
  }

  #[test]
  fn custom_conditions() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "custom".into() => ExportsField::String("./custom.js".into()),
          "default".into() => ExportsField::String("./default.js".into())
        }),
        ..Default::default()
      },
      &cache,
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::NODE, &["custom".into()], &cache)
        .unwrap(),
      cache.get_normalized("/foo/custom.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::NODE, &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/default.js")
    );
  }

  #[test]
  fn subpath_nested_conditions() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./lite".into() => ExportsField::Map(indexmap! {
            "node".into() => ExportsField::Map(indexmap! {
              "import".into() => ExportsField::String("./node_import.js".into()),
              "require".into() => ExportsField::String("./node_require.js".into())
            }),
            "browser".into() => ExportsField::Map(indexmap! {
              "import".into() => ExportsField::String("./browser_import.js".into()),
              "require".into() => ExportsField::String("./browser_require.js".into())
            }),
          })
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports(
          "lite",
          ExportsCondition::NODE | ExportsCondition::IMPORT,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/node_import.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(
          "lite",
          ExportsCondition::NODE | ExportsCondition::REQUIRE,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/node_require.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(
          "lite",
          ExportsCondition::BROWSER | ExportsCondition::IMPORT,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/browser_import.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(
          "lite",
          ExportsCondition::BROWSER | ExportsCondition::REQUIRE,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/browser_require.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports("lite", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
  }

  #[test]
  fn subpath_star() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./*".into() => ExportsField::String("./cheese/*.mjs".into()),
          "./pizza/*".into() => ExportsField::String("./pizza/*.mjs".into()),
          "./burritos/*".into() => ExportsField::String("./burritos/*/*.mjs".into()),
          "./literal".into() => ExportsField::String("./literal/*.js".into()),
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports("hello", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/cheese/hello.mjs")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("hello/world", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/cheese/hello/world.mjs")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("hello.js", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/cheese/hello.js.mjs")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("pizza/test", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/pizza/test.mjs")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("burritos/test", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/burritos/test/test.mjs")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("literal", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/literal/*.js")
    );

    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./*".into() => ExportsField::String("./*.js".into()),
          "./*.js".into() => ExportsField::None,
          "./internal/*".into() => ExportsField::None,
        }),
        ..Default::default()
      },
      &cache,
    );
    assert_eq!(
      pkg
        .resolve_package_exports("file", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/file.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports("file.js", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("internal/file", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
  }

  #[test]
  fn exports_null() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./features/*.js".into() => ExportsField::String("./src/features/*.js".into()),
          "./features/private-internal/*".into() => ExportsField::None,
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports("features/foo.js", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/src/features/foo.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(
          "features/foo/bar.js",
          ExportsCondition::empty(),
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/src/features/foo/bar.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports(
        "features/private-internal/foo.js",
        ExportsCondition::empty(),
        &[],
        &cache
      ),
      Err(PackageJsonError::PackagePathNotExported)
    ),);
  }

  #[test]
  fn exports_array() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./utils/*".into() => ExportsField::Map(indexmap! {
            "browser".into() => ExportsField::Map(indexmap! {
              "worklet".into() => ExportsField::Array(vec![ExportsField::String("./*".into()), ExportsField::String("./node/*".into())]),
              "default".into() => ExportsField::Map(indexmap! {
                "node".into() => ExportsField::String("./node/*".into())
              })
            })
          }),
          "./test/*".into() => ExportsField::Array(vec![ExportsField::String("lodash/*".into()), ExportsField::String("./bar/*".into())]),
          "./file".into() => ExportsField::Array(vec![ExportsField::String("http://a.com".into()), ExportsField::String("./file.js".into())])
        }),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports(
          "utils/index.js",
          ExportsCondition::BROWSER | ExportsCondition::WORKLET,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/index.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports(
          "utils/index.js",
          ExportsCondition::BROWSER | ExportsCondition::NODE,
          &[],
          &cache
        )
        .unwrap(),
      cache.get_normalized("/foo/node/index.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("test/index.js", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/bar/index.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("file", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/file.js")
    );
    assert!(matches!(
      pkg.resolve_package_exports("utils/index.js", ExportsCondition::BROWSER, &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("dir/file.js", ExportsCondition::BROWSER, &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));

    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Array(vec![
          ExportsField::Map(indexmap! {
            "node".into() => ExportsField::String("./a.js".into())
          }),
          ExportsField::String("./b.js".into()),
        ]),
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/b.js")
    );
    assert_eq!(
      pkg
        .resolve_package_exports("", ExportsCondition::NODE, &[], &cache)
        .unwrap(),
      cache.get_normalized("/foo/a.js")
    );
  }

  #[test]
  fn exports_invalid() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          "./invalid".into() => ExportsField::String("../invalid".into()),
          "./absolute".into() => ExportsField::String("/absolute".into()),
          "./package".into() => ExportsField::String("package".into()),
          "./utils/index".into() => ExportsField::String("./src/../index.js".into()),
          "./dist/*".into() => ExportsField::String("./src/../../*".into()),
          "./modules/*".into() => ExportsField::String("./node_modules/*".into()),
          "./modules2/*".into() => ExportsField::String("./NODE_MODULES/*".into()),
          "./*/*".into() => ExportsField::String("./file.js".into())
        }),
        ..Default::default()
      },
      &cache,
    );

    assert!(matches!(
      pkg.resolve_package_exports("invalid", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("absolute", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("package", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("utils/index", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("dist/foo", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("modules/foo", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("a/b", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("a/*", ExportsCondition::empty(), &[], &cache),
      Err(PackageJsonError::PackagePathNotExported)
    ));

    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        exports: ExportsField::Map(indexmap! {
          ".".into() => ExportsField::String("./foo.js".into()),
          "node".into() => ExportsField::String("./bar.js".into()),
        }),
        ..Default::default()
      },
      &cache,
    );

    assert!(matches!(
      pkg.resolve_package_exports("", ExportsCondition::NODE, &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
    assert!(matches!(
      pkg.resolve_package_exports("", ExportsCondition::NODE, &[], &cache),
      Err(PackageJsonError::InvalidPackageTarget)
    ));
  }

  #[test]
  fn imports() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        imports: indexmap! {
          "#foo".into() => ExportsField::String("./foo.mjs".into()),
          "#internal/*".into() => ExportsField::String("./src/internal/*.mjs".into()),
          "#bar".into() => ExportsField::String("bar".into()),
        },
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg
        .resolve_package_imports("foo", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      ExportsResolution::Path(cache.get_normalized("/foo/foo.mjs"))
    );
    assert_eq!(
      pkg
        .resolve_package_imports("internal/foo", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      ExportsResolution::Path(cache.get_normalized("/foo/src/internal/foo.mjs"))
    );
    assert_eq!(
      pkg
        .resolve_package_imports("bar", ExportsCondition::empty(), &[], &cache)
        .unwrap(),
      ExportsResolution::Package("bar".into())
    );
  }

  #[test]
  fn import_conditions() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        imports: indexmap! {
          "#entry/*".into() => ExportsField::Map(indexmap! {
            "node".into() => ExportsField::String("./node/*.js".into()),
            "browser".into() => ExportsField::String("./browser/*.js".into())
          })
        },
        ..Default::default()
      },
      &cache,
    );
    assert_eq!(
      pkg
        .resolve_package_imports("entry/foo", ExportsCondition::NODE, &[], &cache)
        .unwrap(),
      ExportsResolution::Path(cache.get_normalized("/foo/node/foo.js"))
    );
    assert_eq!(
      pkg
        .resolve_package_imports("entry/foo", ExportsCondition::BROWSER, &[], &cache)
        .unwrap(),
      ExportsResolution::Path(cache.get_normalized("/foo/browser/foo.js"))
    );
    assert_eq!(
      pkg
        .resolve_package_imports(
          "entry/foo",
          ExportsCondition::NODE | ExportsCondition::BROWSER,
          &[],
          &cache
        )
        .unwrap(),
      ExportsResolution::Path(cache.get_normalized("/foo/node/foo.js"))
    );
  }

  #[test]
  fn aliases() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        alias: indexmap! {
          "./foo.js".into() => AliasValue::Specifier("./foo-alias.js".into()),
          "bar".into()  => AliasValue::Specifier("./bar-alias.js".into()),
          "lodash".into()  => AliasValue::Specifier("my-lodash".into()),
          "lodash/clone".into()  => AliasValue::Specifier("./clone.js".into()),
          "test".into() => AliasValue::Specifier("./test".into()),
          "foo/*".into() => AliasValue::Specifier("bar/$1".into()),
          "./foo/src/**".into() => AliasValue::Specifier("./foo/lib/$1".into()),
          "/foo/src/**".into() => AliasValue::Specifier("/foo/lib/$1".into()),
          "~/foo/src/**".into() => AliasValue::Specifier("~/foo/lib/$1".into()),
          "url".into() => AliasValue::Bool(false),
          "@internal/**".into() => AliasValue::Specifier("./internal/$1".into()),
          "@foo/*/bar/*".into() => AliasValue::Specifier("./test/$1/$2".into()),
        },
        ..Default::default()
      },
      &cache,
    );

    assert_eq!(
      pkg.resolve_aliases(&"./foo.js".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./foo-alias.js".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"bar".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./bar-alias.js".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"lodash".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("my-lodash".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"lodash/foo".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("my-lodash/foo".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"lodash/clone".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./clone.js".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"test".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./test".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"test/foo".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./test/foo".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"foo/hi".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("bar/hi".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"./foo/src/a/b".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./foo/lib/a/b".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"/foo/src/a/b".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("/foo/lib/a/b".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"~/foo/src/a/b".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("~/foo/lib/a/b".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"url".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Bool(false)))
    );
    assert_eq!(
      pkg.resolve_aliases(&"@internal/foo".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./internal/foo".into())))
    );
    assert_eq!(
      pkg.resolve_aliases(&"@internal/foo/bar".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier(
        "./internal/foo/bar".into()
      )))
    );
    assert_eq!(
      pkg.resolve_aliases(&"@foo/a/bar/b".into(), Fields::ALIAS),
      Some(Cow::Owned(AliasValue::Specifier("./test/a/b".into())))
    );
  }

  #[allow(clippy::single_range_in_vec_init)]
  #[test]
  fn test_replace_captures() {
    assert_eq!(
      replace_captures("test/$1/$2", "foo/bar/baz", &vec![4..7, 8..11]),
      Cow::Borrowed("test/bar/baz")
    );
    assert_eq!(
      replace_captures("test/$1/$2", "foo/bar/baz", &vec![4..7]),
      Cow::Borrowed("test/bar/$2")
    );
    assert_eq!(
      replace_captures("test/$1/$2/$3", "foo/bar/baz", &vec![4..7, 8..11]),
      Cow::Borrowed("test/bar/baz/$3")
    );
    assert_eq!(
      replace_captures("test/$1/$2/$", "foo/bar/baz", &vec![4..7, 8..11]),
      Cow::Borrowed("test/bar/baz/$")
    );
    assert_eq!(
      replace_captures("te$st/$1/$2", "foo/bar/baz", &vec![4..7, 8..11]),
      Cow::Borrowed("te$st/bar/baz")
    );
  }

  #[test]
  fn side_effects_none() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        ..Default::default()
      },
      &cache,
    );

    assert!(pkg.has_side_effects(Path::new("/foo/index.js")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/index.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));
  }

  #[test]
  fn side_effects_bool() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        side_effects: SideEffects::Boolean(false),
        ..Default::default()
      },
      &cache,
    );

    assert!(!pkg.has_side_effects(Path::new("/foo/index.js")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/index.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));

    let pkg = PackageJson {
      side_effects: SideEffects::Boolean(true),
      ..pkg
    };

    assert!(pkg.has_side_effects(Path::new("/foo/index.js")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/index.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));
  }

  #[test]
  fn side_effects_glob() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        side_effects: SideEffects::String("*.css".into()),
        ..Default::default()
      },
      &cache,
    );

    assert!(pkg.has_side_effects(Path::new("/foo/a.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/baz.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/x/baz.css")));
    assert!(!pkg.has_side_effects(Path::new("/foo/a.js")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/baz.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));

    let pkg = PackageJson {
      side_effects: SideEffects::String("bar/*.css".into()),
      ..pkg
    };

    assert!(!pkg.has_side_effects(Path::new("/foo/a.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/baz.css")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/x/baz.css")));
    assert!(!pkg.has_side_effects(Path::new("/foo/a.js")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/baz.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));

    let pkg = PackageJson {
      side_effects: SideEffects::String("./bar/*.css".into()),
      ..pkg
    };

    assert!(!pkg.has_side_effects(Path::new("/foo/a.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/baz.css")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/x/baz.css")));
    assert!(!pkg.has_side_effects(Path::new("/foo/a.js")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/baz.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));
  }

  #[test]
  fn side_effects_array() {
    let cache = Cache::default();
    let pkg = PackageJson::from_serialized(
      cache.get_normalized("/foo/package.json"),
      SerializedPackageJson {
        name: "foobar".into(),
        side_effects: SideEffects::Array(vec!["*.css".into(), "*.html".into()]),
        ..Default::default()
      },
      &cache,
    );

    assert!(pkg.has_side_effects(Path::new("/foo/a.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/baz.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/x/baz.css")));
    assert!(pkg.has_side_effects(Path::new("/foo/a.html")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/baz.html")));
    assert!(pkg.has_side_effects(Path::new("/foo/bar/x/baz.html")));
    assert!(!pkg.has_side_effects(Path::new("/foo/a.js")));
    assert!(!pkg.has_side_effects(Path::new("/foo/bar/baz.js")));
    assert!(pkg.has_side_effects(Path::new("/index.js")));
  }

  #[test]
  fn parsing() {
    let pkg: SerializedPackageJson = serde_json::from_str(r#"{"type":"script"}"#).unwrap();
    assert_eq!(pkg.module_type, ModuleType::CommonJs);
    let pkg: SerializedPackageJson = serde_json::from_str(r#"{"name":"foo"}"#).unwrap();
    assert_eq!(pkg.module_type, ModuleType::CommonJs);
    let pkg: SerializedPackageJson = serde_json::from_str(r#"{"main":false}"#).unwrap();
    assert_eq!(pkg.main, None);
  }
}
