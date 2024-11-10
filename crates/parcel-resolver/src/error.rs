use crate::specifier::SpecifierError;
use crate::PackageJsonError;
use std::path::PathBuf;
use std::sync::Arc;

/// An error that occcured during resolution.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type")]
pub enum ResolverError {
  /// An unknown URL scheme was found in the specifier.
  UnknownScheme { scheme: String },
  /// An unknown error occurred.
  UnknownError,
  /// A file was not found.
  FileNotFound { relative: PathBuf, from: PathBuf },
  /// A node_modules directory was not found.
  ModuleNotFound { module: String },
  /// A package.json entry field pointed to a non-existent file.
  ModuleEntryNotFound {
    /// The node_modules package name.
    module: String,
    /// Path of the entry found in package.json.
    entry_path: PathBuf,
    /// Path of the package.json.
    package_path: PathBuf,
    /// Package.json field name.
    field: &'static str,
  },
  /// A sub-path could not be found within a node_modules package.
  ModuleSubpathNotFound {
    /// The node_modules package name.
    module: String,
    /// Path of the non-existent file.
    path: PathBuf,
    /// Path of the package.json.
    package_path: PathBuf,
  },
  /// An error parsing JSON.
  JsonError(JsonError),
  /// An I/O error.
  IOError(IOError),
  /// A sub-path was not exported from a package.json.
  PackageJsonError {
    /// The node_modules package name.
    module: String,
    /// The path of the file that is not exported.
    path: PathBuf,
    /// Reason the path was not exported.
    error: PackageJsonError,
  },
  /// A package.json file could not be found above the given path.
  PackageJsonNotFound { from: PathBuf },
  /// Could not parse the specifier.
  InvalidSpecifier(SpecifierError),
  /// Could not find an extended tsconfig.json file.
  TsConfigExtendsNotFound {
    /// Path of the tsconfig.json with the "extends" field.
    tsconfig: PathBuf,
    /// Original error resolving the tsconfig.json extends specifier.
    error: Box<ResolverError>,
  },
}

/// An error parsing JSON.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct JsonError {
  /// Path of the JSON file.
  pub path: PathBuf,
  /// Line number of the error.
  pub line: usize,
  /// Column number of the error.
  pub column: usize,
  /// Reason for the error.
  pub message: String,
}

impl JsonError {
  pub fn new(path: PathBuf, err: serde_json::Error) -> JsonError {
    JsonError {
      path,
      line: err.line(),
      column: err.column(),
      message: err.to_string(),
    }
  }
}

#[derive(Debug, Clone)]
pub struct IOError(Arc<std::io::Error>);

impl serde::Serialize for IOError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    #[derive(serde::Serialize)]
    struct IOErrorMessage {
      message: String,
    }

    let msg = IOErrorMessage {
      message: self.0.to_string(),
    };

    msg.serialize(serializer)
  }
}

impl PartialEq for IOError {
  fn eq(&self, other: &Self) -> bool {
    self.0.kind() == other.0.kind()
  }
}

impl From<()> for ResolverError {
  fn from(_: ()) -> Self {
    ResolverError::UnknownError
  }
}

impl From<std::str::Utf8Error> for ResolverError {
  fn from(_: std::str::Utf8Error) -> Self {
    ResolverError::UnknownError
  }
}

impl From<JsonError> for ResolverError {
  fn from(e: JsonError) -> Self {
    ResolverError::JsonError(e)
  }
}

impl From<std::io::Error> for ResolverError {
  fn from(e: std::io::Error) -> Self {
    ResolverError::IOError(IOError(Arc::new(e)))
  }
}

impl From<SpecifierError> for ResolverError {
  fn from(value: SpecifierError) -> Self {
    ResolverError::InvalidSpecifier(value)
  }
}

impl std::fmt::Display for ResolverError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{:?}", self)
  }
}

impl std::error::Error for ResolverError {}
