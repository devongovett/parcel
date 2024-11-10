use std::{
  borrow::Cow,
  path::{is_separator, Path, PathBuf},
};

use percent_encoding::percent_decode_str;

use crate::{builtins::BUILTINS, url_to_path::url_to_path, Flags};

/// Indicates how a specifier should be parsed.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum SpecifierType {
  /// Parse the specifier as an ES module specifier.
  /// This treats the specifier like a URL, but with support for bare module specifiers.
  Esm,
  /// Parse the specifier as a CommonJS specifier.
  Cjs,
  /// Parse the specifier as a URL.
  /// Bare specifiers are treated like relative URLs.
  Url,
}

/// An error that occurred while parsing a specifier.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "kind", content = "value")]
pub enum SpecifierError {
  /// Specifier was an empty string.
  EmptySpecifier,
  /// Invalid specifier for an npm package.
  InvalidPackageSpecifier,
  /// Error parsing a URL.
  #[serde(serialize_with = "serialize_url_error")]
  UrlError(url::ParseError),
  /// Invalid `file://` URL.
  InvalidFileUrl,
}

impl From<url::ParseError> for SpecifierError {
  fn from(value: url::ParseError) -> Self {
    SpecifierError::UrlError(value)
  }
}

fn serialize_url_error<S>(value: &url::ParseError, serializer: S) -> Result<S::Ok, S::Error>
where
  S: serde::Serializer,
{
  use serde::Serialize;
  value.to_string().serialize(serializer)
}

/// Represents a module specifier.
#[derive(PartialEq, Eq, Hash, Clone, Debug)]
pub enum Specifier<'a> {
  /// A relative specifier, e.g. './foo'.
  Relative(Cow<'a, Path>),
  /// An absolute specifier, e.g. '/foo/bar'.
  Absolute(Cow<'a, Path>),
  /// A tilde specifier, e.g. '~/foo'.
  Tilde(Cow<'a, Path>),
  /// A hash specifier, e.g. '#foo'.
  Hash(Cow<'a, str>),
  /// A package specifier and subpath, e.g. 'lodash/clone'.
  Package(Cow<'a, str>, Cow<'a, str>),
  /// A Node builtin module, e.g. 'path' or 'node:path'.
  Builtin(Cow<'a, str>),
  /// A URL specifier.
  Url(&'a str),
}

impl<'a> Specifier<'a> {
  /// Parses a specifier.
  pub fn parse(
    specifier: &'a str,
    specifier_type: SpecifierType,
    flags: Flags,
  ) -> Result<(Specifier<'a>, Option<&'a str>), SpecifierError> {
    if specifier.is_empty() {
      return Err(SpecifierError::EmptySpecifier);
    }

    Ok(match specifier.as_bytes()[0] {
      b'.' => {
        let specifier = if let Some(specifier) = specifier.strip_prefix("./") {
          specifier.trim_start_matches('/')
        } else {
          specifier
        };
        let (path, query) = decode_path(specifier, specifier_type);
        (Specifier::Relative(path), query)
      }
      b'~' => {
        let mut specifier = &specifier[1..];
        if !specifier.is_empty() && is_separator(specifier.as_bytes()[0] as char) {
          specifier = &specifier[1..];
        }
        let (path, query) = decode_path(specifier, specifier_type);
        (Specifier::Tilde(path), query)
      }
      b'/' => {
        if specifier.starts_with("//") && specifier_type == SpecifierType::Url {
          // A protocol-relative URL, e.g `url('//example.com/foo.png')`.
          (Specifier::Url(specifier), None)
        } else {
          let (path, query) = decode_path(specifier, specifier_type);
          (Specifier::Absolute(path), query)
        }
      }
      b'#' => (Specifier::Hash(Cow::Borrowed(&specifier[1..])), None),
      _ => {
        // Bare specifier.
        match specifier_type {
          SpecifierType::Url | SpecifierType::Esm => {
            // Check if there is a scheme first.
            if let Ok((scheme, rest)) = parse_scheme(specifier) {
              let (path, rest) = parse_path(rest);
              let (query, _) = parse_query(rest);
              match scheme.as_ref() {
                "npm" if flags.contains(Flags::NPM_SCHEME) => {
                  if BUILTINS.contains(&path) {
                    return Ok((Specifier::Builtin(Cow::Borrowed(path)), None));
                  }

                  (
                    parse_package(percent_decode_str(path).decode_utf8_lossy())?,
                    query,
                  )
                }
                "node" => {
                  // Node does not URL decode or support query params here.
                  // See https://github.com/nodejs/node/issues/39710.
                  (Specifier::Builtin(Cow::Borrowed(path)), None)
                }
                "file" => (
                  Specifier::Absolute(Cow::Owned(url_to_path(specifier)?)),
                  query,
                ),
                _ => (Specifier::Url(specifier), None),
              }
            } else {
              // If not, then parse as an npm package if this is an ESM specifier,
              // otherwise treat this as a relative path.
              let (path, rest) = parse_path(specifier);
              if specifier_type == SpecifierType::Esm {
                if BUILTINS.contains(&path) {
                  return Ok((Specifier::Builtin(Cow::Borrowed(path)), None));
                }

                let (query, _) = parse_query(rest);
                (
                  parse_package(percent_decode_str(path).decode_utf8_lossy())?,
                  query,
                )
              } else {
                let (path, query) = decode_path(specifier, specifier_type);
                (Specifier::Relative(path), query)
              }
            }
          }
          SpecifierType::Cjs => {
            if let Some(node_prefixed) = specifier.strip_prefix("node:") {
              return Ok((Specifier::Builtin(Cow::Borrowed(node_prefixed)), None));
            }

            if BUILTINS.contains(&specifier) {
              (Specifier::Builtin(Cow::Borrowed(specifier)), None)
            } else {
              #[cfg(windows)]
              if !flags.contains(Flags::ABSOLUTE_SPECIFIERS) {
                let path = Path::new(specifier);
                if path.is_absolute() {
                  return Ok((Specifier::Absolute(Cow::Borrowed(path)), None));
                }
              }

              (parse_package(Cow::Borrowed(specifier))?, None)
            }
          }
        }
      }
    })
  }

  /// Converts the specifier to a string.
  pub fn to_string(&'a self) -> Cow<'a, str> {
    match self {
      Specifier::Relative(path) | Specifier::Absolute(path) | Specifier::Tilde(path) => {
        path.as_os_str().to_string_lossy()
      }
      Specifier::Hash(path) => path.clone(),
      Specifier::Package(module, subpath) => {
        if subpath.is_empty() {
          Cow::Borrowed(module)
        } else {
          let mut res = String::with_capacity(module.len() + subpath.len() + 1);
          res.push_str(module);
          res.push('/');
          res.push_str(subpath);
          Cow::Owned(res)
        }
      }
      Specifier::Builtin(builtin) => Cow::Borrowed(builtin),
      Specifier::Url(url) => Cow::Borrowed(url),
    }
  }
}

// https://url.spec.whatwg.org/#scheme-state
// https://github.com/servo/rust-url/blob/1c1e406874b3d2aa6f36c5d2f3a5c2ea74af9efb/url/src/parser.rs#L387
pub(crate) fn parse_scheme(input: &str) -> Result<(Cow<'_, str>, &str), ()> {
  if input.is_empty() || !input.starts_with(ascii_alpha) {
    return Err(());
  }
  let mut is_lowercase = true;
  for (i, c) in input.chars().enumerate() {
    match c {
      'A'..='Z' => {
        is_lowercase = false;
      }
      'a'..='z' | '0'..='9' | '+' | '-' | '.' => {}
      ':' => {
        let scheme = &input[0..i];
        let rest = &input[i + 1..];
        return Ok(if is_lowercase {
          (Cow::Borrowed(scheme), rest)
        } else {
          (Cow::Owned(scheme.to_ascii_lowercase()), rest)
        });
      }
      _ => {
        return Err(());
      }
    }
  }

  // EOF before ':'
  Err(())
}

// https://url.spec.whatwg.org/#path-state
fn parse_path(input: &str) -> (&str, &str) {
  // We don't really want to normalize the path (e.g. replacing ".." and "." segments).
  // That is done later. For now, we just need to find the end of the path.
  if let Some(pos) = input.chars().position(|c| c == '?' || c == '#') {
    (&input[0..pos], &input[pos..])
  } else {
    (input, "")
  }
}

// https://url.spec.whatwg.org/#query-state
fn parse_query(input: &str) -> (Option<&str>, &str) {
  if !input.is_empty() && input.as_bytes()[0] == b'?' {
    if let Some(pos) = input.chars().position(|c| c == '#') {
      (Some(&input[0..pos]), &input[pos..])
    } else {
      (Some(input), "")
    }
  } else {
    (None, input)
  }
}

/// https://url.spec.whatwg.org/#ascii-alpha
#[inline]
fn ascii_alpha(ch: char) -> bool {
  ch.is_ascii_alphabetic()
}

fn parse_package(specifier: Cow<'_, str>) -> Result<Specifier, SpecifierError> {
  match specifier {
    Cow::Borrowed(specifier) => {
      let (module, subpath) = parse_package_specifier(specifier)?;
      Ok(Specifier::Package(
        Cow::Borrowed(module),
        Cow::Borrowed(subpath),
      ))
    }
    Cow::Owned(specifier) => {
      let (module, subpath) = parse_package_specifier(&specifier)?;
      Ok(Specifier::Package(
        Cow::Owned(module.to_owned()),
        Cow::Owned(subpath.to_owned()),
      ))
    }
  }
}

pub fn parse_package_specifier(specifier: &str) -> Result<(&str, &str), SpecifierError> {
  let idx = specifier.chars().position(|p| p == '/');
  if specifier.starts_with('@') {
    let idx = idx.ok_or(SpecifierError::InvalidPackageSpecifier)?;
    if let Some(next) = &specifier[idx + 1..].chars().position(|p| p == '/') {
      Ok((
        &specifier[0..idx + 1 + *next],
        &specifier[idx + *next + 2..],
      ))
    } else {
      Ok((specifier, ""))
    }
  } else if let Some(idx) = idx {
    Ok((&specifier[0..idx], &specifier[idx + 1..]))
  } else {
    Ok((specifier, ""))
  }
}

pub(crate) fn decode_path(
  specifier: &str,
  specifier_type: SpecifierType,
) -> (Cow<'_, Path>, Option<&str>) {
  match specifier_type {
    SpecifierType::Url | SpecifierType::Esm => {
      let (path, rest) = parse_path(specifier);
      let (query, _) = parse_query(rest);
      let path = match percent_decode_str(path).decode_utf8_lossy() {
        Cow::Borrowed(v) => Cow::Borrowed(Path::new(v)),
        Cow::Owned(v) => Cow::Owned(PathBuf::from(v)),
      };
      (path, query)
    }
    SpecifierType::Cjs => (Cow::Borrowed(Path::new(specifier)), None),
  }
}

impl<'a> From<&'a str> for Specifier<'a> {
  fn from(specifier: &'a str) -> Self {
    Specifier::parse(specifier, SpecifierType::Cjs, Flags::empty())
      .unwrap()
      .0
  }
}

impl<'de> serde::Deserialize<'de> for Specifier<'static> {
  fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
  where
    D: serde::Deserializer<'de>,
  {
    use serde::Deserialize;
    let s: String = Deserialize::deserialize(deserializer)?;
    // Specifiers are only deserialized as part of the "alias" and "browser" fields,
    // so we assume CJS specifiers in Parcel mode.
    Specifier::parse(&s, SpecifierType::Cjs, Flags::empty())
      .map(|s| match s.0 {
        Specifier::Relative(a) => Specifier::Relative(Cow::Owned(a.into_owned())),
        Specifier::Absolute(a) => Specifier::Absolute(Cow::Owned(a.into_owned())),
        Specifier::Tilde(a) => Specifier::Tilde(Cow::Owned(a.into_owned())),
        Specifier::Hash(a) => Specifier::Hash(Cow::Owned(a.into_owned())),
        Specifier::Package(a, b) => {
          Specifier::Package(Cow::Owned(a.into_owned()), Cow::Owned(b.into_owned()))
        }
        Specifier::Builtin(a) => Specifier::Builtin(Cow::Owned(a.into_owned())),
        Specifier::Url(_) => todo!(),
      })
      .map_err(|_| serde::de::Error::custom("Invalid specifier"))
  }
}
