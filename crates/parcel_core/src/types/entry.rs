use std::path::PathBuf;

/// A resolved entry file for the build
#[derive(Clone, Debug, Hash, PartialEq)]
pub struct Entry {
  pub file_path: PathBuf,
  pub target: Option<String>,
}
