//! parcel-resolver implements the Node.js module resolution algorithm.
//! It supports both CommonJS and ES module resolution, along with many
//! additional features supported by various tools in the JavaScript ecosystem,
//! such as TypeScript's tsconfig paths and extension rewriting, the "alias"
//! and "browser" fields used by bundlers, absolute and tilde paths, and more.
//! These can be individually turned on or off using feature flags.
//!
//! For a full description of all supported resolution features, see [Parcel's documentation](https://parceljs.org/features/dependency-resolution/).
//!
//! # Example
//!
//! To create a resolver, first create a [Cache]. This stores information about the files
//! in a [FileSystem], and can be reused between multiple resolvers. A fresh cache
//! should generally be created once per build to ensure information is up to date.
//!
//! Next, create a [Resolver] using one of the constructors. For example, `Resolver::node`
//! creates a Node.js compatible CommonJS resolver, `Resolver::node_esm` creates an ESM resolver,
//! and `Resolver::parcel` creates a Parcel-compatible resolver. From there you can customize individual
//! features such as extensions or index files by setting properties on the resolver.
//!
//! Finally, call `resolver.resolve` to resolve a specifier. This returns a result, along with [Invalidations]
//! describing the files that should invalidate any resolution caches.
//!
//! ```
//! use parcel_resolver::{Cache, Resolver, SpecifierType, ResolutionAndQuery};
//! use std::path::Path;
//!
//! let cache = Cache::default();
//! let resolver = Resolver::node_esm(Path::new("/path/to/project-root"), &cache);
//!
//! let res = resolver.resolve(
//!   "lodash",
//!   Path::new("/path/to/project-root/index.js"),
//!   SpecifierType::Esm
//! );
//!
//! if let Ok(ResolutionAndQuery { resolution, query }) = res.result {
//!   // Do something with the resolution!
//! }
//! ```

use std::{
  borrow::Cow,
  cell::OnceCell,
  collections::HashMap,
  path::{is_separator, Path, PathBuf},
  sync::Arc,
};

use bitflags::bitflags;

use cache::private::CacheCow;
pub use cache::Cache;
use cache::CachedPath;
pub use error::ResolverError;
#[cfg(not(target_arch = "wasm32"))]
pub use fs::OsFileSystem;
pub use fs::{FileKind, FileSystem};
pub use invalidations::*;
use package_json::{AliasValue, ExportsResolution, PackageJson};
pub use package_json::{ExportsCondition, Fields, ModuleType, PackageJsonError};
use specifier::{parse_package_specifier, parse_scheme};
pub use specifier::{Specifier, SpecifierError, SpecifierType};
use tsconfig::TsConfigWrapper;

mod builtins;
mod cache;
mod error;
mod fs;
mod invalidations;
mod json_comments_rs;
mod package_json;
mod specifier;
mod tsconfig;
mod url_to_path;

bitflags! {
  /// Resolution features to enable.
  pub struct Flags: u16 {
    /// Parcel-style absolute paths resolved relative to project root.
    const ABSOLUTE_SPECIFIERS = 1 << 0;
    /// Parcel-style tilde specifiers resolved relative to nearest module root.
    const TILDE_SPECIFIERS = 1 << 1;
    /// The `npm:` scheme.
    const NPM_SCHEME = 1 << 2;
    /// The "alias" field in package.json.
    const ALIASES = 1 << 3;
    /// The settings in tsconfig.json.
    const TSCONFIG = 1 << 4;
    /// The "exports" and "imports" fields in package.json.
    const EXPORTS = 1 << 5;
    /// Directory index files, e.g. index.js.
    const DIR_INDEX = 1 << 6;
    /// Optional extensions in specifiers, using the `extensions` setting.
    const OPTIONAL_EXTENSIONS = 1 << 7;
    /// Whether extensions are replaced in specifiers, e.g. `./foo.js` -> `./foo.ts`.
    /// This also allows omitting the `.ts` and `.tsx` extensions when outside node_modules.
    const TYPESCRIPT_EXTENSIONS = 1 << 8;
    /// Whether to allow omitting the extension when resolving the same file type.
    const PARENT_EXTENSION = 1 << 9;
    /// Whether to allow optional extensions in the "exports" field.
    const EXPORTS_OPTIONAL_EXTENSIONS = 1 << 10;

    /// Default Node settings for CommonJS.
    const NODE_CJS = Self::EXPORTS.bits | Self::DIR_INDEX.bits | Self::OPTIONAL_EXTENSIONS.bits;
    /// Default Node settings for ESM.
    const NODE_ESM = Self::EXPORTS.bits;
    /// Default TypeScript settings.
    const TYPESCRIPT = Self::TSCONFIG.bits | Self::EXPORTS.bits | Self::DIR_INDEX.bits | Self::OPTIONAL_EXTENSIONS.bits | Self::TYPESCRIPT_EXTENSIONS.bits | Self::EXPORTS_OPTIONAL_EXTENSIONS.bits;
  }
}

/// Describes which modules in node_modules should be resolved.
#[derive(Clone)]
pub enum IncludeNodeModules {
  /// Whether or not to include all node_modules.
  Bool(bool),
  /// An array of node_modules to include.
  Array(Vec<String>),
  /// A mapping of node_modules and whether to include them.
  Map(HashMap<String, bool>),
}

impl Default for IncludeNodeModules {
  fn default() -> Self {
    IncludeNodeModules::Bool(true)
  }
}

type ResolveModuleDir = dyn Fn(&str, &Path) -> Result<PathBuf, ResolverError> + Send + Sync;

/// Implements the Node.js module resolution algorithm.
pub struct Resolver<'a> {
  /// The root path of the project.
  pub project_root: CachedPath,
  /// A list of file extensions to try when resolving.
  pub extensions: Extensions<'a>,
  /// A file name (without extension) for the index file of a directory.
  pub index_file: &'a str,
  /// package.json entry fields to try.
  pub entries: Fields,
  /// Resolution features to enable.
  pub flags: Flags,
  /// Configures which node_modules should be resolved.
  pub include_node_modules: Cow<'a, IncludeNodeModules>,
  /// package.json "exports" conditions to enable.
  pub conditions: ExportsCondition,
  /// A custom module directory resolution function, e.g. Yarn PnP.
  pub module_dir_resolver: Option<Arc<ResolveModuleDir>>,
  cache: CacheCow<'a>,
}

/// A list of file extensions to try when resolving.
pub enum Extensions<'a> {
  Borrowed(&'a [&'a str]),
  Owned(Vec<String>),
}

impl<'a> Extensions<'a> {
  fn iter(&self) -> impl Iterator<Item = &str> {
    match self {
      Extensions::Borrowed(v) => itertools::Either::Left(v.iter().copied()),
      Extensions::Owned(v) => itertools::Either::Right(v.iter().map(|s| s.as_str())),
    }
  }
}

/// Options for individual resolution requests.
#[derive(Default, Debug)]
pub struct ResolveOptions {
  /// Known condition flags.
  pub conditions: ExportsCondition,
  /// Custom conditions.
  pub custom_conditions: Vec<String>,
}

/// Describes the result of a resolution request.
#[derive(Debug, PartialEq, Eq, Clone, serde::Serialize)]
#[serde(tag = "type", content = "value")]
pub enum Resolution {
  /// Resolved to a file path.
  Path(PathBuf),
  /// Resolved to a runtime builtin module.
  Builtin(String),
  /// Resolved to an external module that should not be bundled.
  External,
  /// Resolved to an empty module (e.g. `false` in the package.json#browser field).
  Empty,
  /// Resolved to a global variable.
  Global(String),
}

/// The resolved path and query string from the original specifier, if any.
#[derive(Debug, PartialEq, Eq, Clone, serde::Serialize)]
pub struct ResolutionAndQuery {
  /// The result of the resolution request.
  pub resolution: Resolution,
  /// The query string from the original specifier, if any.
  pub query: Option<String>,
}

/// The result of a resolution request, and list of files that should invalidate the cache.
pub struct ResolveResult {
  /// The resolution result.
  pub result: Result<ResolutionAndQuery, ResolverError>,
  /// List of files that should invalidate the cache.
  pub invalidations: Invalidations,
}

impl<'a> Resolver<'a> {
  /// Creates a resolver with Node.js CommonJS settings.
  pub fn node<C: Into<CacheCow<'a>>>(project_root: &Path, cache: C) -> Self {
    let cache: CacheCow = cache.into();
    Self {
      project_root: cache.get(&project_root),
      extensions: Extensions::Borrowed(&["js", "json", "node"]),
      index_file: "index",
      entries: Fields::MAIN,
      flags: Flags::NODE_CJS,
      cache,
      include_node_modules: Cow::Owned(IncludeNodeModules::default()),
      conditions: ExportsCondition::NODE,
      module_dir_resolver: None,
    }
  }

  /// Creates a resolver with Node.js ESM settings.
  pub fn node_esm<C: Into<CacheCow<'a>>>(project_root: &Path, cache: C) -> Self {
    let cache: CacheCow = cache.into();
    Self {
      project_root: cache.get(&project_root),
      extensions: Extensions::Borrowed(&[]),
      index_file: "index",
      entries: Fields::MAIN,
      flags: Flags::NODE_ESM,
      cache,
      include_node_modules: Cow::Owned(IncludeNodeModules::default()),
      conditions: ExportsCondition::NODE,
      module_dir_resolver: None,
    }
  }

  /// Creates a resolver with Parcel settings.
  pub fn parcel<C: Into<CacheCow<'a>>>(project_root: &Path, cache: C) -> Self {
    let cache: CacheCow = cache.into();
    Self {
      project_root: cache.get(&project_root),
      extensions: Extensions::Borrowed(&["mjs", "js", "jsx", "cjs", "json"]),
      index_file: "index",
      entries: Fields::MAIN | Fields::SOURCE | Fields::BROWSER | Fields::MODULE,
      flags: Flags::all(),
      cache,
      include_node_modules: Cow::Owned(IncludeNodeModules::default()),
      conditions: ExportsCondition::empty(),
      module_dir_resolver: None,
    }
  }

  /// Resolves a specifier relative to the given path, with default options.
  pub fn resolve(
    &self,
    specifier: &str,
    from: &Path,
    specifier_type: SpecifierType,
  ) -> ResolveResult {
    self.resolve_with_options(specifier, from, specifier_type, Default::default())
  }

  /// Resolves a specifier relative to the given path, with custom options.
  pub fn resolve_with_options(
    &self,
    specifier: &str,
    from: &Path,
    specifier_type: SpecifierType,
    options: ResolveOptions,
  ) -> ResolveResult {
    let invalidations = Invalidations::default();
    let result =
      self.resolve_with_invalidations(specifier, from, specifier_type, &invalidations, options);

    ResolveResult {
      result,
      invalidations,
    }
  }

  /// Resolves a specifier with pre-existing Invalidations.
  pub fn resolve_with_invalidations(
    &self,
    specifier: &str,
    from: &Path,
    specifier_type: SpecifierType,
    invalidations: &Invalidations,
    options: ResolveOptions,
  ) -> Result<ResolutionAndQuery, ResolverError> {
    let (specifier, query) = match Specifier::parse(specifier, specifier_type, self.flags) {
      Ok(s) => s,
      Err(e) => return Err(e.into()),
    };
    let from = self.cache.get(from);
    let mut request = ResolveRequest::new(self, &specifier, specifier_type, &from, invalidations);
    if !options.conditions.is_empty() || !options.custom_conditions.is_empty() {
      // If custom conditions are defined, these override the default conditions inferred from the specifier type.
      request.conditions = self.conditions | options.conditions;
      request.custom_conditions = options.custom_conditions.as_slice();
    }

    match request.resolve() {
      Ok(r) => Ok(ResolutionAndQuery {
        resolution: r,
        query: query.map(|q| q.to_owned()),
      }),
      Err(r) => Err(r),
    }
  }

  /// Returns whether the given path has side effects, according to its parent package.json.
  pub fn resolve_side_effects(
    &self,
    path: &Path,
    invalidations: &Invalidations,
  ) -> Result<bool, ResolverError> {
    if let Some(package) = self.find_package(&self.cache.get(path.parent().unwrap()), invalidations)
    {
      Ok(unwrap_arc(&package)?.has_side_effects(path))
    } else {
      Ok(true)
    }
  }

  /// Returns the module type (CommonJS, ESM, or JSON) of the given path,
  /// according to either its extension or the package.json `type` field.
  pub fn resolve_module_type(
    &self,
    path: &Path,
    invalidations: &Invalidations,
  ) -> Result<ModuleType, ResolverError> {
    if let Some(ext) = path.extension() {
      if ext == "mjs" {
        return Ok(ModuleType::Module);
      }

      if ext == "cjs" || ext == "node" {
        return Ok(ModuleType::CommonJs);
      }

      if ext == "json" {
        return Ok(ModuleType::Json);
      }

      if ext == "js" {
        if let Some(package) =
          self.find_package(&self.cache.get(path.parent().unwrap()), invalidations)
        {
          return Ok(unwrap_arc(&package)?.module_type);
        }
      }
    }

    Ok(ModuleType::CommonJs)
  }

  fn find_package(
    &self,
    from: &CachedPath,
    invalidations: &Invalidations,
  ) -> Option<Arc<Result<PackageJson, ResolverError>>> {
    if let Some(path) = self.find_ancestor_file(from, "package.json", invalidations) {
      let package = path.package_json(&self.cache);
      return Some(package);
    }

    None
  }

  fn find_ancestor_file(
    &self,
    from: &CachedPath,
    filename: &str,
    invalidations: &Invalidations,
  ) -> Option<CachedPath> {
    let mut first = true;
    for dir in from.ancestors() {
      if dir.is_node_modules() {
        break;
      }

      let file = dir.join(filename, &self.cache);
      if file.is_file(&*self.cache.fs) {
        invalidations.invalidate_on_file_change(file.clone());
        return Some(file);
      }

      if *dir == self.project_root {
        break;
      }

      if first {
        invalidations.invalidate_on_file_create_above(filename, from.clone());
      }

      first = false;
    }

    None
  }

  /// Returns the resolution cache.
  pub fn cache(&self) -> &Cache {
    &self.cache
  }
}

struct ResolveRequest<'a> {
  resolver: &'a Resolver<'a>,
  specifier: &'a Specifier<'a>,
  specifier_type: SpecifierType,
  from: &'a CachedPath,
  flags: RequestFlags,
  tsconfig: OnceCell<Option<Arc<Result<TsConfigWrapper, ResolverError>>>>,
  root_package: OnceCell<Option<Arc<Result<PackageJson, ResolverError>>>>,
  invalidations: &'a Invalidations,
  conditions: ExportsCondition,
  custom_conditions: &'a [String],
  priority_extension: Option<&'a str>,
}

bitflags! {
  struct RequestFlags: u8 {
    const IN_TS_FILE = 1 << 0;
    const IN_JS_FILE = 1 << 1;
    const IN_NODE_MODULES = 1 << 2;
  }
}

impl<'a> ResolveRequest<'a> {
  fn new(
    resolver: &'a Resolver<'a>,
    specifier: &'a Specifier<'a>,
    mut specifier_type: SpecifierType,
    from: &'a CachedPath,
    invalidations: &'a Invalidations,
  ) -> Self {
    let mut flags = RequestFlags::empty();
    let ext = from.extension();
    if let Some(ext) = ext {
      if ext == "ts" || ext == "tsx" || ext == "mts" || ext == "cts" {
        flags |= RequestFlags::IN_TS_FILE;
      } else if ext == "js" || ext == "jsx" || ext == "mjs" || ext == "cjs" {
        flags |= RequestFlags::IN_JS_FILE;
      }
    }

    if from.in_node_modules() {
      flags |= RequestFlags::IN_NODE_MODULES;
    }

    // Replace the specifier type for `npm:` URLs so we resolve it like a module.
    if specifier_type == SpecifierType::Url && matches!(specifier, Specifier::Package(..)) {
      specifier_type = SpecifierType::Esm;
    }

    // Add "import" or "require" condition to global conditions based on specifier type.
    // Also add the "module" condition if the "module" entry field is enabled.
    let mut conditions = resolver.conditions;
    let module_condition = if resolver.entries.contains(Fields::MODULE) {
      ExportsCondition::MODULE
    } else {
      ExportsCondition::empty()
    };
    match specifier_type {
      SpecifierType::Esm => conditions |= ExportsCondition::IMPORT | module_condition,
      SpecifierType::Cjs => conditions |= ExportsCondition::REQUIRE | module_condition,
      _ => {}
    }

    // Store the parent file extension so we can prioritize it even in sub-requests.
    let priority_extension = if resolver.flags.contains(Flags::PARENT_EXTENSION) {
      ext.and_then(|ext| ext.to_str())
    } else {
      None
    };

    Self {
      resolver,
      specifier,
      specifier_type,
      from,
      flags,
      tsconfig: OnceCell::new(),
      root_package: OnceCell::new(),
      invalidations,
      conditions,
      custom_conditions: &[],
      priority_extension,
    }
  }

  fn resolve_aliases(
    &self,
    package: &PackageJson,
    specifier: &Specifier,
    fields: Fields,
  ) -> Result<Option<Resolution>, ResolverError> {
    // Don't resolve alias if it came from the package.json itself (i.e. another alias).
    if *self.from == package.path {
      return Ok(None);
    }

    match package.resolve_aliases(specifier, fields) {
      Some(alias) => match alias.as_ref() {
        AliasValue::Specifier(specifier) => {
          let mut req = ResolveRequest::new(
            self.resolver,
            specifier,
            SpecifierType::Cjs,
            &package.path,
            self.invalidations,
          );
          req.priority_extension = self.priority_extension;
          req.conditions = self.conditions;
          req.custom_conditions = self.custom_conditions;
          let resolved = req.resolve()?;
          Ok(Some(resolved))
        }
        AliasValue::Bool(false) => Ok(Some(Resolution::Empty)),
        AliasValue::Bool(true) => Ok(None),
        AliasValue::Global { global } => Ok(Some(Resolution::Global((*global).to_owned()))),
      },
      None => Ok(None),
    }
  }

  fn root_package(&self) -> &Option<Arc<Result<PackageJson, ResolverError>>> {
    self
      .root_package
      .get_or_init(|| self.find_package(&self.resolver.project_root))
  }

  fn resolve(&self) -> Result<Resolution, ResolverError> {
    match &self.specifier {
      Specifier::Relative(specifier) => {
        // Relative path
        self.resolve_relative(specifier, self.from)
      }
      Specifier::Tilde(specifier) if self.resolver.flags.contains(Flags::TILDE_SPECIFIERS) => {
        // Tilde path. Resolve relative to nearest node_modules directory,
        // the nearest directory with package.json or the project root - whichever comes first.
        if let Some(p) = self.find_ancestor_file(self.from, "package.json") {
          return self.resolve_relative(specifier, &p);
        }

        Err(ResolverError::PackageJsonNotFound {
          from: self.from.as_path().to_owned(),
        })
      }
      Specifier::Absolute(specifier) => {
        // In Parcel mode, absolute paths are actually relative to the project root.
        if self.resolver.flags.contains(Flags::ABSOLUTE_SPECIFIERS) {
          self.resolve_relative(
            specifier.strip_prefix("/").unwrap(),
            &self
              .resolver
              .project_root
              .join("index", &self.resolver.cache),
          )
        } else if let Some(res) = self.load_path(&self.resolver.cache.get(&specifier), None)? {
          Ok(res)
        } else {
          Err(ResolverError::FileNotFound {
            relative: specifier.as_ref().to_owned(),
            from: PathBuf::from("/"),
          })
        }
      }
      Specifier::Hash(hash) => {
        if self.specifier_type == SpecifierType::Url {
          // An ID-only URL, e.g. `url(#clip-path)` for CSS rules. Ignore.
          Ok(Resolution::External)
        } else if self.specifier_type == SpecifierType::Esm
          && self.resolver.flags.contains(Flags::EXPORTS)
        {
          // An internal package #import specifier.
          let package = self.find_package(self.from.parent().unwrap_or_else(|| self.from));
          if let Some(package) = package {
            let package = unwrap_arc(&package)?;
            let res = package
              .resolve_package_imports(
                hash,
                self.conditions,
                self.custom_conditions,
                &self.resolver.cache,
              )
              .map_err(|error| ResolverError::PackageJsonError {
                error,
                module: package.name.to_owned(),
                path: package.path.as_path().into(),
              })?;
            match res {
              ExportsResolution::Path(path) => {
                // Extensionless specifiers are not supported in the imports field.
                if let Some(res) = self.try_file_without_aliases(&path)? {
                  return Ok(res);
                }
              }
              ExportsResolution::Package(specifier) => {
                let (module, subpath) = parse_package_specifier(&specifier)?;
                // TODO: should this follow aliases??
                return self.resolve_bare(module, subpath);
              }
              _ => {}
            }
          }

          Err(ResolverError::PackageJsonNotFound {
            from: self.from.as_path().to_owned(),
          })
        } else {
          Err(ResolverError::UnknownError)
        }
      }
      Specifier::Package(module, subpath) => {
        // Bare specifier.
        self.resolve_bare(module, subpath)
      }
      Specifier::Builtin(builtin) => {
        if let Some(res) = self.resolve_package_aliases_and_tsconfig_paths(self.specifier)? {
          return Ok(res);
        }
        Ok(Resolution::Builtin(builtin.as_ref().to_owned()))
      }
      Specifier::Url(url) => {
        if self.specifier_type == SpecifierType::Url {
          Ok(Resolution::External)
        } else {
          let (scheme, _) = parse_scheme(url)?;
          Err(ResolverError::UnknownScheme {
            scheme: scheme.into_owned(),
          })
        }
      }
      _ => Err(ResolverError::UnknownError),
    }
  }

  fn find_ancestor_file(&self, from: &CachedPath, filename: &str) -> Option<CachedPath> {
    let from = from.parent().unwrap();
    self
      .resolver
      .find_ancestor_file(&from, filename, self.invalidations)
  }

  fn find_package(&self, from: &CachedPath) -> Option<Arc<Result<PackageJson, ResolverError>>> {
    self.resolver.find_package(from, self.invalidations)
  }

  fn resolve_relative(
    &self,
    specifier: &Path,
    from: &CachedPath,
  ) -> Result<Resolution, ResolverError> {
    // Resolve aliases from the nearest package.json.
    let path = from.resolve(specifier, &self.resolver.cache);
    let package = if self.resolver.flags.contains(Flags::ALIASES) {
      self.find_package(&path.parent().unwrap())
    } else {
      None
    };

    let package = match &package {
      Some(pkg) => Some(unwrap_arc(pkg)?),
      None => None,
    };

    if let Some(res) = self.load_path(&path, package)? {
      return Ok(res);
    }

    Err(ResolverError::FileNotFound {
      relative: specifier.to_owned(),
      from: from.as_path().to_owned(),
    })
  }

  fn resolve_bare(&self, module: &str, subpath: &str) -> Result<Resolution, ResolverError> {
    let include = match self.resolver.include_node_modules.as_ref() {
      IncludeNodeModules::Bool(b) => *b,
      IncludeNodeModules::Array(a) => a.iter().any(|v| v == module),
      IncludeNodeModules::Map(m) => *m.get(module).unwrap_or(&true),
    };

    if !include {
      return Ok(Resolution::External);
    }

    // Try aliases and tsconfig paths first.
    let specifier = Specifier::Package(Cow::Borrowed(module), Cow::Borrowed(subpath));
    if let Some(res) = self.resolve_package_aliases_and_tsconfig_paths(&specifier)? {
      return Ok(res);
    }

    self.resolve_node_module(module, subpath)
  }

  fn resolve_package_aliases_and_tsconfig_paths(
    &self,
    specifier: &Specifier,
  ) -> Result<Option<Resolution>, ResolverError> {
    if self.resolver.flags.contains(Flags::ALIASES) {
      // First, check for an alias in the root package.json.
      if let Some(package) = self.root_package() {
        if let Some(res) = self.resolve_aliases(unwrap_arc(package)?, specifier, Fields::ALIAS)? {
          return Ok(Some(res));
        }
      }

      // Next, try the local package.json.
      if let Some(package) = self.find_package(self.from.parent().unwrap_or_else(|| self.from)) {
        let mut fields = Fields::ALIAS;
        if self.resolver.entries.contains(Fields::BROWSER) {
          fields |= Fields::BROWSER;
        }
        if let Some(res) = self.resolve_aliases(unwrap_arc(&package)?, specifier, fields)? {
          return Ok(Some(res));
        }
      }
    }

    // Next, check tsconfig.json for the paths and baseUrl options.
    self.resolve_tsconfig_paths()
  }

  fn resolve_node_module(&self, module: &str, subpath: &str) -> Result<Resolution, ResolverError> {
    // If there is a custom module directory resolver (e.g. Yarn PnP), use that.
    if let Some(module_dir_resolver) = &self.resolver.module_dir_resolver {
      let package_dir = module_dir_resolver(module, self.from.as_path())?;
      return self.resolve_package(self.resolver.cache.get(&package_dir), module, subpath);
    } else {
      let mut file_name = String::with_capacity(module.len() + 13);
      file_name.push_str("node_modules/");
      file_name.push_str(module);
      self.invalidations.invalidate_on_file_create_above(
        file_name,
        self
          .from
          .parent()
          .cloned()
          .unwrap_or_else(|| self.from.clone()),
      );

      for dir in self.from.ancestors() {
        // Skip over node_modules directories
        if dir.is_node_modules() {
          continue;
        }

        let package_dir = dir.join_module(module, &self.resolver.cache);
        if package_dir.is_dir(&*self.resolver.cache.fs) {
          return self.resolve_package(package_dir, module, subpath);
        }
      }
    }

    // NODE_PATH??

    Err(ResolverError::ModuleNotFound {
      module: module.to_owned(),
    })
  }

  fn resolve_package(
    &self,
    package_dir: CachedPath,
    module: &str,
    subpath: &str,
  ) -> Result<Resolution, ResolverError> {
    let package_path = package_dir.join("package.json", &self.resolver.cache);
    let package = self.invalidations.read(&package_path, || {
      package_path.package_json(&self.resolver.cache)
    });

    let package = match &*package {
      Ok(package) => package,
      Err(ResolverError::IOError(_)) => {
        // No package.json in node_modules is probably invalid but we have tests for it...
        if self.resolver.flags.contains(Flags::DIR_INDEX) {
          if let Some(res) = self.load_file(
            &package_dir.join(self.resolver.index_file, &self.resolver.cache),
            None,
          )? {
            return Ok(res);
          }
        }

        return Err(ResolverError::ModuleNotFound {
          module: module.to_owned(),
        });
      }
      Err(err) => return Err(err.clone()),
    };

    // Try the "source" field first, if present.
    if self.resolver.entries.contains(Fields::SOURCE) && subpath.is_empty() {
      if let Some(source) = package.source(&self.resolver.cache) {
        if let Some(res) = self.load_path(&source, Some(&*package))? {
          return Ok(res);
        }
      }
    }

    // If the exports field is present, use the Node ESM algorithm.
    // Otherwise, fall back to classic CJS resolution.
    if self.resolver.flags.contains(Flags::EXPORTS) && package.has_exports() {
      let path = package
        .resolve_package_exports(
          subpath,
          self.conditions,
          self.custom_conditions,
          &self.resolver.cache,
        )
        .map_err(|e| ResolverError::PackageJsonError {
          module: package.name.to_owned(),
          path: package.path.as_path().to_path_buf(),
          error: e,
        })?;

      // Extensionless specifiers are not supported in the exports field
      // according to the Node spec (for both ESM and CJS). However, webpack
      // didn't follow this, so there are many packages that rely on it (e.g. underscore).
      if self
        .resolver
        .flags
        .contains(Flags::EXPORTS_OPTIONAL_EXTENSIONS)
      {
        if let Some(res) = self.load_file(&path, Some(&*package))? {
          return Ok(res);
        }
      } else if let Some(res) = self.try_file_without_aliases(&path)? {
        return Ok(res);
      }

      // TODO: track location of resolved field
      Err(ResolverError::ModuleSubpathNotFound {
        module: module.to_owned(),
        path: path.as_path().to_path_buf(),
        package_path: package.path.as_path().to_path_buf(),
      })
    } else if !subpath.is_empty() {
      let package_dir = package_dir.join(subpath, &self.resolver.cache);
      if let Some(res) = self.load_path(&package_dir, Some(&*package))? {
        return Ok(res);
      }

      Err(ResolverError::ModuleSubpathNotFound {
        module: module.to_owned(),
        path: package_dir.as_path().to_owned(),
        package_path: package.path.as_path().to_path_buf(),
      })
    } else {
      let res = self.try_package_entries(&*package);
      if let Ok(Some(res)) = res {
        return Ok(res);
      }

      // Node ESM doesn't allow directory imports.
      if self.resolver.flags.contains(Flags::DIR_INDEX) {
        if let Some(res) = self.load_file(
          &package_dir.join(self.resolver.index_file, &self.resolver.cache),
          Some(&*package),
        )? {
          return Ok(res);
        }
      }

      res?;

      Err(ResolverError::ModuleSubpathNotFound {
        module: module.to_owned(),
        path: package_dir.as_path().join(self.resolver.index_file),
        package_path: package.path.as_path().to_path_buf(),
      })
    }
  }

  fn try_package_entries(
    &self,
    package: &PackageJson,
  ) -> Result<Option<Resolution>, ResolverError> {
    // Try all entry fields.
    if let Some((entry, field)) = package
      .entries(self.resolver.entries, &self.resolver.cache)
      .next()
    {
      if let Some(res) = self.load_path(&entry, Some(package))? {
        return Ok(Some(res));
      } else {
        return Err(ResolverError::ModuleEntryNotFound {
          module: package.name.to_owned(),
          entry_path: entry.as_path().to_path_buf(),
          package_path: package.path.as_path().to_path_buf(),
          field,
        });
      }
    }

    Ok(None)
  }

  fn load_path(
    &self,
    path: &CachedPath,
    package: Option<&PackageJson>,
  ) -> Result<Option<Resolution>, ResolverError> {
    // Urls and Node ESM do not resolve directory index files.
    let can_load_directory =
      self.resolver.flags.contains(Flags::DIR_INDEX) && self.specifier_type != SpecifierType::Url;

    // If path ends with / only try loading as a directory.
    let is_directory = can_load_directory
      && path
        .as_path()
        .as_os_str()
        .to_str()
        .map(|s| s.ends_with(is_separator))
        .unwrap_or(false);

    if !is_directory {
      if let Some(res) = self.load_file(path, package)? {
        return Ok(Some(res));
      }
    }

    // Urls and Node ESM do not resolve directory index files.
    if can_load_directory {
      return self.load_directory(path, package);
    }

    Ok(None)
  }

  fn load_file(
    &self,
    path: &CachedPath,
    package: Option<&PackageJson>,
  ) -> Result<Option<Resolution>, ResolverError> {
    // First try the path as is.
    // TypeScript only supports resolving specifiers ending with `.ts` or `.tsx`
    // in a certain mode, but we always allow it.
    // If there is no extension in the original specifier, only check aliases
    // here and delay checking for an extensionless file until later (since this is unlikely).
    if let Some(res) = self.try_suffixes(path, "", package, path.extension().is_none())? {
      return Ok(Some(res));
    }

    // TypeScript allows a specifier like "./foo.js" to resolve to "./foo.ts".
    // TSC does this before trying to append an extension. We match this
    // rather than matching "./foo.js.ts", which seems more unlikely.
    // However, if "./foo.js" exists we will resolve to it (above), unlike TSC.
    // This is to match Node and other bundlers.
    if self.resolver.flags.contains(Flags::TYPESCRIPT_EXTENSIONS)
      && self.flags.contains(RequestFlags::IN_TS_FILE)
      && !self.flags.contains(RequestFlags::IN_NODE_MODULES)
      && self.specifier_type != SpecifierType::Url
    {
      if let Some(ext) = path.extension() {
        // TODO: would be nice if there was a way to do this without cloning
        // but OsStr doesn't let you create a slice.
        let without_extension = &path.as_path().with_extension("");
        let extensions: Option<&[&str]> = if ext == "js" || ext == "jsx" {
          // TSC always prioritizes .ts over .tsx, even when the original extension was .jsx.
          Some(&["ts", "tsx"])
        } else if ext == "mjs" {
          Some(&["mts"])
        } else if ext == "cjs" {
          Some(&["cts"])
        } else {
          None
        };

        let res = if let Some(extensions) = extensions {
          self.try_extensions(
            &self.resolver.cache.get(without_extension),
            package,
            &Extensions::Borrowed(extensions),
            false,
          )?
        } else {
          None
        };

        if res.is_some() {
          return Ok(res);
        }
      }
    }

    // Try adding the same extension as in the parent file first.
    if let Some(ext) = self.priority_extension {
      // Use try_suffixes here to skip the specifier_type check.
      // This is reproducing a bug in the old version of the Parcel resolver
      // where URL dependencies could omit the extension if it was the same as the parent.
      // TODO: Revert this in the next major version.
      if let Some(res) = self.try_suffixes(path, ext, package, false)? {
        return Ok(Some(res));
      }
    }

    // Try adding typescript extensions if outside node_modules.
    if self
      .resolver
      .flags
      .contains(Flags::TYPESCRIPT_EXTENSIONS | Flags::OPTIONAL_EXTENSIONS)
      && !self.flags.contains(RequestFlags::IN_NODE_MODULES)
    {
      if let Some(res) =
        self.try_extensions(path, package, &Extensions::Borrowed(&["ts", "tsx"]), true)?
      {
        return Ok(Some(res));
      }
    }

    // Try appending the configured extensions.
    if let Some(res) = self.try_extensions(path, package, &self.resolver.extensions, true)? {
      return Ok(Some(res));
    }

    // If there is no extension in the specifier, try an extensionless file as a last resort.
    if path.extension().is_none() {
      if let Some(res) = self.try_suffixes(path, "", package, false)? {
        return Ok(Some(res));
      }
    }

    Ok(None)
  }

  fn try_extensions(
    &self,
    path: &CachedPath,
    package: Option<&PackageJson>,
    extensions: &Extensions,
    skip_parent: bool,
  ) -> Result<Option<Resolution>, ResolverError> {
    if self.resolver.flags.contains(Flags::OPTIONAL_EXTENSIONS)
      && self.specifier_type != SpecifierType::Url
    {
      // Try appending each extension.
      for ext in extensions.iter() {
        // Skip parent extension if we already tried it.
        if skip_parent
          && self.resolver.flags.contains(Flags::PARENT_EXTENSION)
          && matches!(self.from.extension(), Some(e) if e == ext)
        {
          continue;
        }

        if let Some(res) = self.try_suffixes(path, ext, package, false)? {
          return Ok(Some(res));
        }
      }
    }

    Ok(None)
  }

  fn try_suffixes(
    &self,
    path: &CachedPath,
    ext: &str,
    package: Option<&PackageJson>,
    alias_only: bool,
  ) -> Result<Option<Resolution>, ResolverError> {
    // TypeScript supports a moduleSuffixes option in tsconfig.json which allows suffixes
    // such as ".ios" to be appended just before the last extension.
    let tsconfig = self.tsconfig();
    let default_module_suffixes = [String::new()];
    let mut module_suffixes = default_module_suffixes.as_slice();
    if let Some(tsconfig) = &tsconfig {
      let tsconfig = unwrap_arc(tsconfig)?;
      if let Some(suffixes) = &tsconfig.compiler_options.module_suffixes {
        module_suffixes = suffixes.as_slice();
      }
    }

    for suffix in module_suffixes {
      let mut p = if !suffix.is_empty() {
        // The suffix is placed before the _last_ extension. If we will be appending
        // another extension later, then we only need to append the suffix first.
        // Otherwise, we need to remove the original extension so we can add the suffix.
        // TODO: TypeScript only removes certain extensions here...
        let original_ext = path.extension();
        let mut s = if ext.is_empty() && original_ext.is_some() {
          path.as_path().with_extension("").into_os_string()
        } else {
          path.as_path().into()
        };

        // Append the suffix (this is not necessarily an extension).
        s.push(suffix);

        // Re-add the original extension if we removed it earlier.
        if ext.is_empty() {
          if let Some(original_ext) = original_ext {
            s.push(".");
            s.push(original_ext);
          }
        }

        Cow::Owned(self.resolver.cache.get(Path::new(&s)))
      } else {
        Cow::Borrowed(path)
      };

      if !ext.is_empty() {
        // Append the extension.
        p = Cow::Owned(p.into_owned().add_extension(ext, &self.resolver.cache));
      }

      if let Some(res) = self.try_file(&p, package, alias_only)? {
        return Ok(Some(res));
      }
    }

    Ok(None)
  }

  fn try_file(
    &self,
    path: &CachedPath,
    package: Option<&PackageJson>,
    alias_only: bool,
  ) -> Result<Option<Resolution>, ResolverError> {
    if self.resolver.flags.contains(Flags::ALIASES) {
      // Check the project root package.json first.
      if let Some(package) = self.root_package() {
        let package = unwrap_arc(package)?;
        if let Ok(s) = path
          .as_path()
          .strip_prefix(package.path.parent().unwrap().as_path())
        {
          let specifier = Specifier::Relative(Cow::Borrowed(s));
          if let Some(res) = self.resolve_aliases(&*package, &specifier, Fields::ALIAS)? {
            return Ok(Some(res));
          }
        }
      }

      // Next try the local package.json.
      if let Some(package) = package {
        if let Ok(s) = path
          .as_path()
          .strip_prefix(package.path.parent().unwrap().as_path())
        {
          let specifier = Specifier::Relative(Cow::Borrowed(s));
          let mut fields = Fields::ALIAS;
          if self.resolver.entries.contains(Fields::BROWSER) {
            fields |= Fields::BROWSER;
          }
          if let Some(res) = self.resolve_aliases(package, &specifier, fields)? {
            return Ok(Some(res));
          }
        }
      }
    }

    if alias_only {
      return Ok(None);
    }

    self.try_file_without_aliases(path)
  }

  fn try_file_without_aliases(
    &self,
    path: &CachedPath,
  ) -> Result<Option<Resolution>, ResolverError> {
    if path.is_file(&*self.resolver.cache.fs) {
      Ok(Some(Resolution::Path(
        path
          .canonicalize(&self.resolver.cache)?
          .as_path()
          .to_owned(),
      )))
    } else {
      self.invalidations.invalidate_on_file_create(path.clone());
      Ok(None)
    }
  }

  fn load_directory(
    &self,
    dir: &CachedPath,
    parent_package: Option<&PackageJson>,
  ) -> Result<Option<Resolution>, ResolverError> {
    // Check if there is a package.json in this directory, and if so, use its entries.
    // Note that the "exports" field is NOT used here - only in resolve_node_module.
    let path = dir.join("package.json", &self.resolver.cache);
    let mut res = Ok(None);
    let pkg = self
      .invalidations
      .read(&path, || path.package_json(&self.resolver.cache));
    let package = if let Ok(package) = &*pkg {
      res = self.try_package_entries(&*package);
      if matches!(res, Ok(Some(_))) {
        return res;
      }
      Some(package)
    } else {
      None
    };

    // If no package.json, or no entries, try an index file with all possible extensions.
    if self.resolver.flags.contains(Flags::DIR_INDEX) && dir.is_dir(&*self.resolver.cache.fs) {
      return self.load_file(
        &dir.join(self.resolver.index_file, &self.resolver.cache),
        package.as_deref().or(parent_package),
      );
    }

    res
  }

  fn resolve_tsconfig_paths(&self) -> Result<Option<Resolution>, ResolverError> {
    if let Some(tsconfig) = self.tsconfig() {
      for path in unwrap_arc(tsconfig)?
        .compiler_options
        .paths(self.specifier, &self.resolver.cache)
      {
        // TODO: should aliases apply to tsconfig paths??
        if let Some(res) = self.load_path(&path, None)? {
          return Ok(Some(res));
        }
      }
    }

    Ok(None)
  }

  fn tsconfig(&self) -> &Option<Arc<Result<TsConfigWrapper, ResolverError>>> {
    if self.resolver.flags.contains(Flags::TSCONFIG)
      && self
        .flags
        .intersects(RequestFlags::IN_TS_FILE | RequestFlags::IN_JS_FILE)
      && !self.flags.contains(RequestFlags::IN_NODE_MODULES)
    {
      self.tsconfig.get_or_init(|| {
        if let Some(path) = self.find_ancestor_file(self.from, "tsconfig.json") {
          return Some(self.read_tsconfig(path));
        }

        None
      })
    } else {
      &None
    }
  }

  fn read_tsconfig(&self, path: CachedPath) -> Arc<Result<TsConfigWrapper, ResolverError>> {
    self.invalidations.read(&path, || {
      path.tsconfig(&self.resolver.cache, |tsconfig| {
        for i in 0..tsconfig.extends.len() {
          let path = match &tsconfig.extends[i] {
            Specifier::Absolute(path) => self.resolver.cache.get(path),
            Specifier::Relative(path) => {
              let mut absolute_path = tsconfig
                .compiler_options
                .path
                .resolve(path, &self.resolver.cache);

              // TypeScript allows "." and ".." to implicitly refer to a tsconfig.json file.
              if path == Path::new(".") || path == Path::new("..") {
                absolute_path = absolute_path.join("tsconfig.json", &self.resolver.cache);
              }

              let mut exists = absolute_path.is_file(&*self.resolver.cache.fs);

              // If the file doesn't exist, and doesn't end with `.json`, try appending the extension.
              if !exists {
                let try_extension = match absolute_path.extension() {
                  None => true,
                  Some(ext) => ext != "json",
                };

                if try_extension {
                  absolute_path = absolute_path.add_extension("json", &self.resolver.cache);
                  exists = absolute_path.is_file(&*self.resolver.cache.fs);
                }
              }

              if !exists {
                return Err(ResolverError::TsConfigExtendsNotFound {
                  tsconfig: tsconfig.compiler_options.path.as_path().to_path_buf(),
                  error: Box::new(ResolverError::FileNotFound {
                    relative: path.to_path_buf(),
                    from: tsconfig.compiler_options.path.as_path().to_path_buf(),
                  }),
                });
              }

              absolute_path
            }
            specifier @ Specifier::Package(..) => {
              let resolver = Resolver {
                project_root: self.resolver.project_root.clone(),
                extensions: Extensions::Borrowed(&["json"]),
                index_file: "tsconfig.json",
                entries: Fields::TSCONFIG,
                flags: Flags::NODE_CJS,
                cache: CacheCow::Borrowed(&self.resolver.cache),
                include_node_modules: Cow::Owned(IncludeNodeModules::default()),
                conditions: ExportsCondition::TYPES,
                module_dir_resolver: self.resolver.module_dir_resolver.clone(),
              };

              let req = ResolveRequest::new(
                &resolver,
                specifier,
                SpecifierType::Cjs,
                &tsconfig.compiler_options.path,
                self.invalidations,
              );

              let res = req
                .resolve()
                .map_err(|err| ResolverError::TsConfigExtendsNotFound {
                  tsconfig: tsconfig.compiler_options.path.as_path().to_path_buf(),
                  error: Box::new(err),
                })?;

              if let Resolution::Path(res) = res {
                self.resolver.cache.get(&res)
              } else {
                return Err(ResolverError::TsConfigExtendsNotFound {
                  tsconfig: tsconfig.compiler_options.path.as_path().to_path_buf(),
                  error: Box::new(ResolverError::UnknownError),
                });
              }
            }
            _ => return Ok(()),
          };

          let extended = self.read_tsconfig(path);
          match &*extended {
            Ok(extended) => {
              tsconfig.compiler_options.extend(&extended.compiler_options);
            }
            Err(e) => return Err(e.clone()),
          }
        }

        Ok(())
      })
    })
  }
}

fn unwrap_arc<T, E: Clone>(arc: &Arc<Result<T, E>>) -> Result<&T, E> {
  match &**arc {
    Ok(v) => Ok(v),
    Err(e) => Err(e.clone()),
  }
}

#[cfg(test)]
mod tests {
  use std::collections::{HashMap, HashSet};

  use super::*;

  #[derive(PartialEq, Eq, Hash, Debug, Clone)]
  pub enum UncachedFileCreateInvalidation {
    Path(PathBuf),
    FileName { file_name: String, above: PathBuf },
    Glob(String),
  }

  impl From<FileCreateInvalidation> for UncachedFileCreateInvalidation {
    fn from(value: FileCreateInvalidation) -> Self {
      match value {
        FileCreateInvalidation::Path(cached_path) => {
          UncachedFileCreateInvalidation::Path(cached_path.as_path().to_owned())
        }
        FileCreateInvalidation::FileName { file_name, above } => {
          UncachedFileCreateInvalidation::FileName {
            file_name,
            above: above.as_path().to_owned(),
          }
        }
        FileCreateInvalidation::Glob(glob) => UncachedFileCreateInvalidation::Glob(glob),
      }
    }
  }

  fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
      .parent()
      .unwrap()
      .parent()
      .unwrap()
      .join("packages/utils/node-resolver-core/test/fixture")
  }

  fn test_resolver<'a>() -> Resolver<'a> {
    Resolver::parcel(&root(), Cache::default())
  }

  fn node_resolver<'a>() -> Resolver<'a> {
    Resolver::node(&root(), Cache::default())
  }

  #[test]
  fn relative() {
    assert_eq!(
      test_resolver()
        .resolve("./bar.js", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(".///bar.js", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("./bar", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("~/bar", &root().join("nested/test.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("~bar", &root().join("nested/test.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "~/bar",
          &root().join("node_modules/foo/nested/baz.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("./nested", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("./bar?foo=2", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("./bar?foo=2", &root().join("foo.js"), SpecifierType::Cjs)
        .result
        .unwrap_err(),
      ResolverError::FileNotFound {
        relative: "bar?foo=2".into(),
        from: root().join("foo.js")
      },
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./foo",
          &root().join("priority/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("priority/foo.js"))
    );

    let invalidations = test_resolver()
      .resolve("./bar", &root().join("foo.js"), SpecifierType::Esm)
      .invalidations;
    assert_eq!(
      invalidations
        .invalidate_on_file_create
        .borrow()
        .iter()
        .collect::<HashSet<_>>(),
      HashSet::new()
    );
    assert_eq!(
      invalidations
        .invalidate_on_file_change
        .borrow()
        .iter()
        .map(|p| p.as_path().to_owned())
        .collect::<HashSet<_>>(),
      HashSet::from([root().join("package.json"), root().join("tsconfig.json")])
    );
  }

  #[test]
  fn test_absolute() {
    assert_eq!(
      test_resolver()
        .resolve("/bar", &root().join("nested/test.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "/bar",
          &root().join("node_modules/foo/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );

    #[cfg(not(windows))]
    {
      assert_eq!(
        test_resolver()
          .resolve(
            "file:///bar",
            &root().join("nested/test.js"),
            SpecifierType::Esm
          )
          .result
          .unwrap()
          .resolution,
        Resolution::Path(root().join("bar.js"))
      );
      assert_eq!(
        node_resolver()
          .resolve(
            root().join("foo.js").to_str().unwrap(),
            &root().join("nested/test.js"),
            SpecifierType::Esm
          )
          .result
          .unwrap()
          .resolution,
        Resolution::Path(root().join("foo.js"))
      );
      assert_eq!(
        node_resolver()
          .resolve(
            &format!("file://{}", root().join("foo.js").to_str().unwrap()),
            &root().join("nested/test.js"),
            SpecifierType::Esm
          )
          .result
          .unwrap()
          .resolution,
        Resolution::Path(root().join("foo.js"))
      );
    }
  }

  #[test]
  fn node_modules() {
    assert_eq!(
      test_resolver()
        .resolve("foo", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("package-main", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-main/main.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("package-module", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-module/module.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-browser",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-browser/browser.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-fallback",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-fallback/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-main-directory",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-main-directory/nested/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("foo/nested/baz", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/nested/baz.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("@scope/pkg", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/@scope/pkg/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "@scope/pkg/foo/bar",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/@scope/pkg/foo/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo/with space.mjs",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/with space.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo/with%20space.mjs",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/with space.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo/with space.mjs",
          &root().join("foo.js"),
          SpecifierType::Cjs
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/with space.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo/with%20space.mjs",
          &root().join("foo.js"),
          SpecifierType::Cjs
        )
        .result
        .unwrap_err(),
      ResolverError::ModuleSubpathNotFound {
        module: "foo".into(),
        path: root().join("node_modules/foo/with%20space.mjs"),
        package_path: root().join("node_modules/foo/package.json")
      },
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "@scope/pkg?foo=2",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/@scope/pkg/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "@scope/pkg?foo=2",
          &root().join("foo.js"),
          SpecifierType::Cjs
        )
        .result
        .unwrap_err(),
      ResolverError::ModuleNotFound {
        module: "@scope/pkg?foo=2".into()
      },
    );

    let invalidations = test_resolver()
      .resolve("foo", &root().join("foo.js"), SpecifierType::Esm)
      .invalidations;
    assert_eq!(
      invalidations
        .invalidate_on_file_create
        .borrow()
        .iter()
        .map(|p| p.clone().into())
        .collect::<HashSet<_>>(),
      HashSet::from([UncachedFileCreateInvalidation::FileName {
        file_name: "node_modules/foo".into(),
        above: root()
      },])
    );
    assert_eq!(
      invalidations
        .invalidate_on_file_change
        .borrow()
        .iter()
        .map(|p| p.as_path().to_owned())
        .collect::<HashSet<_>>(),
      HashSet::from([
        root().join("node_modules/foo/package.json"),
        root().join("package.json"),
        root().join("tsconfig.json")
      ])
    );
  }

  #[test]
  fn browser_field() {
    assert_eq!(
      test_resolver()
        .resolve(
          "package-browser-alias",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-browser-alias/browser.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-browser-alias/foo",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-browser-alias/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./foo",
          &root().join("node_modules/package-browser-alias/browser.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-browser-alias/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./nested",
          &root().join("node_modules/package-browser-alias/browser.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(
        root().join("node_modules/package-browser-alias/subfolder1/subfolder2/subfile.js")
      )
    );
  }

  #[test]
  fn local_aliases() {
    assert_eq!(
      test_resolver()
        .resolve(
          "package-alias/foo",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-alias/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./foo",
          &root().join("node_modules/package-alias/browser.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-alias/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./lib/test",
          &root().join("node_modules/package-alias-glob/browser.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-alias-glob/src/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-browser-exclude",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Empty
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./lib/test",
          &root().join("node_modules/package-alias-glob/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-alias-glob/src/test.js"))
    );

    let invalidations = test_resolver()
      .resolve(
        "package-alias/foo",
        &root().join("foo.js"),
        SpecifierType::Esm,
      )
      .invalidations;
    assert_eq!(
      invalidations
        .invalidate_on_file_create
        .borrow()
        .iter()
        .map(|p| p.clone().into())
        .collect::<HashSet<_>>(),
      HashSet::from([UncachedFileCreateInvalidation::FileName {
        file_name: "node_modules/package-alias".into(),
        above: root()
      },])
    );
    assert_eq!(
      invalidations
        .invalidate_on_file_change
        .borrow()
        .iter()
        .map(|p| p.as_path().to_owned())
        .collect::<HashSet<_>>(),
      HashSet::from([
        root().join("node_modules/package-alias/package.json"),
        root().join("package.json"),
        root().join("tsconfig.json")
      ])
    );
  }

  #[test]
  fn global_aliases() {
    assert_eq!(
      test_resolver()
        .resolve("aliased", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "aliased",
          &root().join("node_modules/package-alias/foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "aliased/bar",
          &root().join("node_modules/package-alias/foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("aliased-file", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "aliased-file",
          &root().join("node_modules/package-alias/foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "aliasedfolder/test.js",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("aliasedfolder", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "aliasedabsolute/test.js",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "aliasedabsolute",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("foo/bar", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("glob/bar/test", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("something", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "something",
          &root().join("node_modules/package-alias/foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-alias-exclude",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Empty
    );
    assert_eq!(
      test_resolver()
        .resolve("./baz", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("../baz", &root().join("x/foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("~/baz", &root().join("x/foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./baz",
          &root().join("node_modules/foo/bar.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/baz.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "~/baz",
          &root().join("node_modules/foo/bar.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/baz.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "/baz",
          &root().join("node_modules/foo/bar.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("url", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Empty
    );
  }

  #[test]
  fn test_urls() {
    assert_eq!(
      test_resolver()
        .resolve(
          "http://example.com/foo.png",
          &root().join("foo.js"),
          SpecifierType::Url
        )
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "//example.com/foo.png",
          &root().join("foo.js"),
          SpecifierType::Url
        )
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );
    assert_eq!(
      test_resolver()
        .resolve("#hash", &root().join("foo.js"), SpecifierType::Url)
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "http://example.com/foo.png",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::UnknownScheme {
        scheme: "http".into()
      },
    );
    assert_eq!(
      test_resolver()
        .resolve("bar.js", &root().join("foo.js"), SpecifierType::Url)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    // Reproduce bug for now
    // assert_eq!(
    //   test_resolver()
    //     .resolve("bar", &root().join("foo.js"), SpecifierType::Url)
    //     .result
    //     .unwrap_err(),
    //   ResolverError::FileNotFound {
    //     relative: "bar".into(),
    //     from: root().join("foo.js")
    //   }
    // );
    assert_eq!(
      test_resolver()
        .resolve("bar", &root().join("foo.js"), SpecifierType::Url)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("bar.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("npm:foo", &root().join("foo.js"), SpecifierType::Url)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/index.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve("npm:@scope/pkg", &root().join("foo.js"), SpecifierType::Url)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/@scope/pkg/index.js"))
    );
  }

  #[test]
  fn test_exports() {
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/main.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/foo",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      // "browser" field is NOT used.
      Resolution::Path(root().join("node_modules/package-exports/foo.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/features/test",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/features/test.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/extensionless-features/test",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/features/test.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/extensionless-features/test.mjs",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/features/test.mjs"))
    );
    assert_eq!(
      node_resolver()
        .resolve(
          "package-exports/extensionless-features/test",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::ModuleSubpathNotFound {
        module: "package-exports".into(),
        package_path: root().join("node_modules/package-exports/package.json"),
        path: root().join("node_modules/package-exports/features/test"),
      },
    );
    assert_eq!(
      node_resolver()
        .resolve(
          "package-exports/extensionless-features/test",
          &root().join("foo.js"),
          SpecifierType::Cjs
        )
        .result
        .unwrap_err(),
      ResolverError::ModuleSubpathNotFound {
        module: "package-exports".into(),
        package_path: root().join("node_modules/package-exports/package.json"),
        path: root().join("node_modules/package-exports/features/test"),
      },
    );
    assert_eq!(
      node_resolver()
        .resolve(
          "package-exports/extensionless-features/test.mjs",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/features/test.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/space",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/with space.mjs"))
    );
    // assert_eq!(
    //   test_resolver().resolve("package-exports/with%20space", &root().join("foo.js"), SpecifierType::Esm).unwrap().resolution,
    //   Resolution::Path(root().join("node_modules/package-exports/with space.mjs"))
    // );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/with space",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::PackageJsonError {
        module: "package-exports".into(),
        path: root().join("node_modules/package-exports/package.json"),
        error: PackageJsonError::PackagePathNotExported
      },
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/internal",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::PackageJsonError {
        module: "package-exports".into(),
        path: root().join("node_modules/package-exports/package.json"),
        error: PackageJsonError::PackagePathNotExported
      },
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/internal.mjs",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::PackageJsonError {
        module: "package-exports".into(),
        path: root().join("node_modules/package-exports/package.json"),
        error: PackageJsonError::PackagePathNotExported
      },
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/invalid",
          &root().join("foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::PackageJsonError {
        module: "package-exports".into(),
        path: root().join("node_modules/package-exports/package.json"),
        error: PackageJsonError::InvalidPackageTarget
      }
    );
  }

  #[test]
  fn test_self_reference() {
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports",
          &root().join("node_modules/package-exports/foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/main.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "package-exports/foo",
          &root().join("node_modules/package-exports/foo.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/foo.mjs"))
    );
  }

  #[test]
  fn test_imports() {
    assert_eq!(
      test_resolver()
        .resolve(
          "#internal",
          &root().join("node_modules/package-exports/main.mjs"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/package-exports/internal.mjs"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "#foo",
          &root().join("node_modules/package-exports/main.mjs"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/index.js"))
    );
  }

  #[test]
  fn test_builtins() {
    assert_eq!(
      test_resolver()
        .resolve("zlib", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Builtin("zlib".into())
    );
    assert_eq!(
      test_resolver()
        .resolve("node:zlib", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Builtin("zlib".into())
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "node:fs/promises",
          &root().join("foo.js"),
          SpecifierType::Cjs
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Builtin("fs/promises".into())
    );
  }

  #[test]
  fn test_tsconfig() {
    assert_eq!(
      test_resolver()
        .resolve("ts-path", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("foo.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "ts-path",
          &root().join("nested/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("nested/test.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo",
          &root().join("tsconfig/index/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/tsconfig-index/foo.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo",
          &root().join("tsconfig/field/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/tsconfig-field/foo.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo",
          &root().join("tsconfig/exports/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/tsconfig-exports/foo.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "foo",
          &root().join("tsconfig/extends-extension/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/extends-extension/foo.js"))
    );

    let mut extends_node_module_resolver = test_resolver();
    extends_node_module_resolver.include_node_modules = Cow::Owned(IncludeNodeModules::Bool(false));
    assert_eq!(
      extends_node_module_resolver
        .resolve(
          "./bar",
          &root().join("tsconfig/extends-node-module/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/extends-node-module/bar.ts"))
    );

    assert_eq!(
      test_resolver()
        .resolve(
          "ts-path",
          &root().join("node_modules/tsconfig-not-used/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::ModuleNotFound {
        module: "ts-path".into()
      },
    );
    assert_eq!(
      test_resolver()
        .resolve("ts-path", &root().join("foo.css"), SpecifierType::Esm)
        .result
        .unwrap_err(),
      ResolverError::ModuleNotFound {
        module: "ts-path".into()
      },
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "zlib",
          &root().join("tsconfig/builtins/thing.js"),
          SpecifierType::Cjs
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Builtin("zlib".into())
    );

    let invalidations = test_resolver()
      .resolve("ts-path", &root().join("foo.js"), SpecifierType::Esm)
      .invalidations;
    assert_eq!(
      invalidations
        .invalidate_on_file_create
        .borrow()
        .iter()
        .collect::<HashSet<_>>(),
      HashSet::new()
    );
    assert_eq!(
      invalidations
        .invalidate_on_file_change
        .borrow()
        .iter()
        .map(|p| p.as_path().to_owned())
        .collect::<HashSet<_>>(),
      HashSet::from([root().join("package.json"), root().join("tsconfig.json")])
    );
  }

  #[test]
  fn test_module_suffixes() {
    assert_eq!(
      test_resolver()
        .resolve(
          "./a",
          &root().join("tsconfig/suffixes/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/suffixes/a.ios.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./a.ts",
          &root().join("tsconfig/suffixes/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/suffixes/a.ios.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./b",
          &root().join("tsconfig/suffixes/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/suffixes/b.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./b.ts",
          &root().join("tsconfig/suffixes/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/suffixes/b.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./c",
          &root().join("tsconfig/suffixes/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/suffixes/c-test.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./c.ts",
          &root().join("tsconfig/suffixes/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/suffixes/c-test.ts"))
    );
  }

  #[test]
  fn test_tsconfig_parsing() {
    assert_eq!(
      test_resolver()
        .resolve(
          "foo",
          &root().join("tsconfig/trailing-comma/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("tsconfig/trailing-comma/bar.js"))
    );
  }

  #[test]
  fn test_ts_extensions() {
    assert_eq!(
      test_resolver()
        .resolve(
          "./a.js",
          &root().join("ts-extensions/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("ts-extensions/a.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./a.jsx",
          &root().join("ts-extensions/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      // TSC always prioritizes .ts over .tsx
      Resolution::Path(root().join("ts-extensions/a.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./a.mjs",
          &root().join("ts-extensions/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("ts-extensions/a.mts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./a.cjs",
          &root().join("ts-extensions/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("ts-extensions/a.cts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./b.js",
          &root().join("ts-extensions/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      // We deviate from TSC here to match Node/bundlers.
      Resolution::Path(root().join("ts-extensions/b.js"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./c.js",
          &root().join("ts-extensions/index.ts"),
          SpecifierType::Esm
        )
        .result
        .unwrap()
        .resolution,
      // This matches TSC. c.js.ts seems kinda unlikely?
      Resolution::Path(root().join("ts-extensions/c.ts"))
    );
    assert_eq!(
      test_resolver()
        .resolve(
          "./a.js",
          &root().join("ts-extensions/index.js"),
          SpecifierType::Esm
        )
        .result
        .unwrap_err(),
      ResolverError::FileNotFound {
        relative: "a.js".into(),
        from: root().join("ts-extensions/index.js")
      },
    );

    let invalidations = test_resolver()
      .resolve(
        "./a.js",
        &root().join("ts-extensions/index.ts"),
        SpecifierType::Esm,
      )
      .invalidations;
    assert_eq!(
      invalidations
        .invalidate_on_file_create
        .borrow()
        .iter()
        .map(|p| p.clone().into())
        .collect::<HashSet<_>>(),
      HashSet::from([
        UncachedFileCreateInvalidation::Path(root().join("ts-extensions/a.js")),
        UncachedFileCreateInvalidation::FileName {
          file_name: "package.json".into(),
          above: root().join("ts-extensions")
        },
        UncachedFileCreateInvalidation::FileName {
          file_name: "tsconfig.json".into(),
          above: root().join("ts-extensions")
        },
      ])
    );
    assert_eq!(
      invalidations
        .invalidate_on_file_change
        .borrow()
        .iter()
        .map(|p| p.as_path().to_owned())
        .collect::<HashSet<_>>(),
      HashSet::from([root().join("package.json"), root().join("tsconfig.json")])
    );
  }

  fn resolve_side_effects(specifier: &str, from: &Path) -> bool {
    let resolver = test_resolver();
    let resolved = resolver
      .resolve(specifier, from, SpecifierType::Esm)
      .result
      .unwrap()
      .resolution;

    if let Resolution::Path(path) = resolved {
      resolver
        .resolve_side_effects(&path, &Invalidations::default())
        .unwrap()
    } else {
      unreachable!()
    }
  }

  #[test]
  fn test_side_effects() {
    assert!(!resolve_side_effects(
      "side-effects-false/src/index.js",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-false/src/index",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-false/src/",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-false",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-package-redirect-up/foo/bar",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-package-redirect-down/foo/bar",
      &root().join("foo.js")
    ));
    assert!(resolve_side_effects(
      "side-effects-false-glob/a/index",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-false-glob/b/index.js",
      &root().join("foo.js")
    ));
    assert!(!resolve_side_effects(
      "side-effects-false-glob/sub/a/index.js",
      &root().join("foo.js")
    ));
    assert!(resolve_side_effects(
      "side-effects-false-glob/sub/index.json",
      &root().join("foo.js")
    ));
  }

  #[test]
  fn test_include_node_modules() {
    let mut resolver = test_resolver();
    resolver.include_node_modules = Cow::Owned(IncludeNodeModules::Bool(false));

    assert_eq!(
      resolver
        .resolve("foo", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );
    assert_eq!(
      resolver
        .resolve("@scope/pkg", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );

    resolver.include_node_modules = Cow::Owned(IncludeNodeModules::Array(vec!["foo".into()]));
    assert_eq!(
      resolver
        .resolve("foo", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/foo/index.js"))
    );
    assert_eq!(
      resolver
        .resolve("@scope/pkg", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );

    resolver.include_node_modules = Cow::Owned(IncludeNodeModules::Map(HashMap::from([
      ("foo".into(), false),
      ("@scope/pkg".into(), true),
    ])));
    assert_eq!(
      resolver
        .resolve("foo", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::External
    );
    assert_eq!(
      resolver
        .resolve("@scope/pkg", &root().join("foo.js"), SpecifierType::Esm)
        .result
        .unwrap()
        .resolution,
      Resolution::Path(root().join("node_modules/@scope/pkg/index.js"))
    );
  }

  // #[test]
  // fn test_visitor() {
  //   let resolved = test_resolver().resolve("unified", &root(), SpecifierType::Esm).unwrap();
  //   println!("{:?}", resolved);
  //   if let Resolution::Path(p) = resolved {
  //     let res = build_esm_graph(
  //       &p,
  //       root()
  //     ).unwrap();
  //     println!("{:?}", res);
  //   }
  // }
}
