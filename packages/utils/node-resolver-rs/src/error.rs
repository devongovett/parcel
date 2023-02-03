use crate::PackageJsonError;
use crate::{cache::JsonError, specifier::SpecifierError};
use std::{path::PathBuf, rc::Rc};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "type")]
pub enum ResolverError {
  UnknownScheme {
    scheme: String,
  },
  UnknownError,
  FileNotFound {
    relative: PathBuf,
    from: PathBuf,
  },
  ModuleNotFound {
    module: String,
  },
  ModuleEntryNotFound {
    module: String,
    entry_path: PathBuf,
    package_path: PathBuf,
    field: &'static str,
  },
  ModuleSubpathNotFound {
    module: String,
    path: PathBuf,
    package_path: PathBuf,
  },
  InvalidAlias,
  JsonError(JsonError),
  IOError(IOError),
  PackageJsonError {
    module: String,
    path: PathBuf,
    error: PackageJsonError,
  },
  PackageJsonNotFound {
    from: PathBuf,
  },
  InvalidSpecifier(SpecifierError),
}

#[derive(Debug, Clone)]
pub struct IOError(Rc<std::io::Error>);

impl serde::Serialize for IOError {
  fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
  where
    S: serde::Serializer,
  {
    self.0.to_string().serialize(serializer)
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
    ResolverError::IOError(IOError(Rc::new(e)))
  }
}

impl From<SpecifierError> for ResolverError {
  fn from(value: SpecifierError) -> Self {
    ResolverError::InvalidSpecifier(value)
  }
}
