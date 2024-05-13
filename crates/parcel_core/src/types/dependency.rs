use std::hash::Hash;
use std::hash::Hasher;
use std::path::PathBuf;

use bitflags::bitflags;
use gxhash::GxHasher;
use parcel_resolver::ExportsCondition;
use serde::Deserialize;
use serde::Serialize;
use serde_repr::Deserialize_repr;
use serde_repr::Serialize_repr;

use super::bundle::BundleBehavior;
use super::environment::Environment;
use super::json::JSONObject;
use super::source::SourceLocation;
use super::symbol::Symbol;
use super::target::Target;
use crate::bitflags_serde;

/// A dependency denotes a connection between two assets
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
  /// Controls the behavior of the bundle the resolved asset is placed into
  ///
  /// This option is used in combination with priority to determine when the bundle is loaded.
  ///
  pub bundle_behavior: BundleBehavior,

  /// The environment of the dependency
  pub env: Environment,

  /// Information that represents the state of the dependency
  pub flags: DependencyFlags,

  /// The location within the source file where the dependency was found
  #[serde(default)]
  pub loc: Option<SourceLocation>,

  /// Plugin-specific metadata for the dependency
  #[serde(default)]
  pub meta: JSONObject,

  /// A list of custom conditions to use when resolving package.json "exports" and "imports"
  ///
  /// This will be combined with the conditions from the environment. However, it overrides the default "import" and "require" conditions inferred from the specifierType. To include those in addition to custom conditions, explicitly add them to this list.
  ///
  #[serde(default)]
  pub package_conditions: ExportsCondition,

  /// The pipeline defined in .parcelrc that the dependency should be processed with
  #[serde(default)]
  pub pipeline: Option<String>,

  /// Determines when the dependency should be loaded
  pub priority: Priority,

  /// The semver version range expected for the dependency
  pub range: Option<String>,

  /// The file path where the dependency should be resolved from
  ///
  /// By default, this is the path of the source file where the dependency was specified.
  ///
  pub resolve_from: Option<PathBuf>,

  /// The id of the asset with this dependency
  pub source_asset_id: Option<String>,

  /// The file path of the asset with this dependency
  pub source_path: Option<PathBuf>,

  /// The import or export specifier that connects two assets together
  pub specifier: String,

  /// How the specifier should be interpreted
  pub specifier_type: SpecifierType,

  #[serde(default)]
  pub symbols: Vec<Symbol>,

  /// The target associated with an entry, if any
  #[serde(default)]
  pub target: Option<Box<Target>>,
}

impl Dependency {
  pub fn new(specifier: String, env: Environment) -> Dependency {
    Dependency {
      bundle_behavior: BundleBehavior::None,
      env,
      flags: DependencyFlags::empty(),
      loc: None,
      meta: JSONObject::new(),
      package_conditions: ExportsCondition::empty(),
      pipeline: None,
      priority: Priority::default(),
      range: None,
      resolve_from: None,
      source_asset_id: None,
      source_path: None,
      specifier,
      specifier_type: SpecifierType::default(),
      symbols: Vec::new(),
      target: None,
    }
  }

  pub fn id(&self) -> u64 {
    // Compute hashed dependency id
    let mut hasher = GxHasher::default();

    self.bundle_behavior.hash(&mut hasher);
    self.env.hash(&mut hasher);
    self.package_conditions.hash(&mut hasher);
    self.pipeline.hash(&mut hasher);
    self.priority.hash(&mut hasher);
    self.source_path.hash(&mut hasher);
    self.specifier.hash(&mut hasher);
    self.specifier_type.hash(&mut hasher);

    hasher.finish()
  }
}

bitflags! {
  #[derive(Clone, Copy, Debug, Hash)]
  pub struct DependencyFlags: u8 {
    const ENTRY    = 1 << 0;
    const OPTIONAL = 1 << 1;
    const NEEDS_STABLE_NAME = 1 << 2;
    const SHOULD_WRAP = 1 << 3;
    const IS_ESM = 1 << 4;
    const IS_WEBWORKER = 1 << 5;
    const HAS_SYMBOLS = 1 << 6;
  }
}

bitflags_serde!(DependencyFlags);

#[derive(Clone, Debug, Deserialize, Hash, Serialize)]
pub struct ImportAttribute {
  pub key: String,
  pub value: bool,
}

/// Determines when a dependency should load
#[derive(Clone, Copy, Debug, Deserialize_repr, Eq, Hash, PartialEq, Serialize_repr)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum Priority {
  /// Resolves the dependency synchronously, placing the resolved asset in the same bundle as the parent or another bundle that is already on the page
  Sync = 0,
  /// Places the dependency in a separate bundle loaded in parallel with the current bundle
  Parallel = 1,
  /// The dependency should be placed in a separate bundle that is loaded later
  Lazy = 2,
}

impl Default for Priority {
  fn default() -> Self {
    Priority::Sync
  }
}

/// The type of the import specifier
#[derive(Clone, Copy, Debug, Deserialize_repr, Eq, Hash, PartialEq, Serialize_repr)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum SpecifierType {
  /// An ES Module specifier
  ///
  /// This is parsed as an URL, but bare specifiers are treated as node_modules.
  ///
  Esm = 0,

  /// A CommonJS specifier
  ///
  /// This is not parsed as an URL.
  ///
  CommonJS = 1,

  /// A URL that works as in a browser
  ///
  /// Bare specifiers are treated as relative URLs.
  ///
  Url = 2,

  /// A custom specifier that must be handled by a custom resolver plugin
  Custom = 3,
}

impl Default for SpecifierType {
  fn default() -> Self {
    SpecifierType::Esm
  }
}
