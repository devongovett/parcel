#![allow(dead_code)]
//! `json_comments` is a library to strip out comments from JSON-like test. By processing text
//! through a [`StripComments`] adapter first, it is possible to use a standard JSON parser (such
//! as [serde_json](https://crates.io/crates/serde_json) with quasi-json input that contains
//! comments.
//!
//! In fact, this code makes few assumptions about the input and could probably be used to strip
//! comments out of other types of code as well, provided that strings use double quotes and
//! backslashes are used for escapes in strings.
//!
//! The following types of comments are supported:
//!   - C style block comments (`/* ... */`)
//!   - C style line comments (`// ...`)
//!   - Shell style line comments (`# ...`)
//!
use std::{
  io::{ErrorKind, Read, Result},
  slice::IterMut,
};

#[derive(Eq, PartialEq, Copy, Clone, Debug)]
enum State {
  Top,
  InString,
  StringEscape,
  InComment,
  InBlockComment,
  MaybeCommentEnd,
  InLineComment,
}

use State::*;

/// A [`Read`] that transforms another [`Read`] so that it changes all comments to spaces so that a downstream json parser
/// (such as json-serde) doesn't choke on them.
///
/// The supported comments are:
///   - C style block comments (`/* ... */`)
///   - C style line comments (`// ...`)
///   - Shell style line comments (`# ...`)
pub struct StripComments<T: Read> {
  inner: T,
  state: State,
  settings: CommentSettings,
}

impl<T> StripComments<T>
where
  T: Read,
{
  pub fn new(input: T) -> Self {
    Self {
      inner: input,
      state: Top,
      settings: CommentSettings::default(),
    }
  }

  /// Create a new `StripComments` with settings which may be different from the default.
  ///
  /// This is useful if you wish to disable allowing certain kinds of comments.
  #[inline]
  pub fn with_settings(settings: CommentSettings, input: T) -> Self {
    Self {
      inner: input,
      state: Top,
      settings,
    }
  }
}

macro_rules! invalid_data {
  () => {
    return Err(ErrorKind::InvalidData.into())
  };
}

impl<T> Read for StripComments<T>
where
  T: Read,
{
  fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
    let count = self.inner.read(buf)?;
    if count > 0 {
      strip_buf(&mut self.state, &mut buf[..count], &self.settings, false)?;
    } else if self.state != Top && self.state != InLineComment {
      invalid_data!();
    }
    Ok(count)
  }
}

fn consume_comment_whitespace_until_maybe_bracket(
  state: &mut State,
  it: &mut IterMut<u8>,
  settings: &CommentSettings,
) -> Result<bool> {
  for c in it.by_ref() {
    *state = match state {
      Top => {
        *state = top(c, settings);
        if c.is_ascii_whitespace() {
          continue;
        } else {
          return Ok(*c == b'}' || *c == b']');
        }
      }
      InString => in_string(*c),
      StringEscape => InString,
      InComment => in_comment(c, settings)?,
      InBlockComment => in_block_comment(c),
      MaybeCommentEnd => maybe_comment_end(c),
      InLineComment => in_line_comment(c),
    };
  }
  Ok(false)
}

fn strip_buf(
  state: &mut State,
  buf: &mut [u8],
  settings: &CommentSettings,
  remove_trailing_commas: bool,
) -> Result<()> {
  let mut it = buf.iter_mut();
  while let Some(c) = it.next() {
    if matches!(state, Top) {
      *state = top(c, settings);
      if remove_trailing_commas
        && *c == b','
        && consume_comment_whitespace_until_maybe_bracket(state, &mut it, settings)?
      {
        *c = b' ';
      }
    } else {
      *state = match state {
        Top => unreachable!(),
        InString => in_string(*c),
        StringEscape => InString,
        InComment => in_comment(c, settings)?,
        InBlockComment => in_block_comment(c),
        MaybeCommentEnd => maybe_comment_end(c),
        InLineComment => in_line_comment(c),
      }
    }
  }
  Ok(())
}

/// Strips comments from a string in place, replacing it with whitespaces.
pub fn strip_comments_in_place(
  s: &mut str,
  settings: CommentSettings,
  remove_trailing_commas: bool,
) -> Result<()> {
  strip_buf(
    &mut Top,
    unsafe { s.as_bytes_mut() },
    &settings,
    remove_trailing_commas,
  )
}

/// Settings for `StripComments`
///
/// The default is for all comment types to be enabled.
#[derive(Copy, Clone, Debug)]
pub struct CommentSettings {
  /// True if c-style block comments (`/* ... */`) are allowed
  block_comments: bool,
  /// True if c-style `//` line comments are allowed
  slash_line_comments: bool,
  /// True if shell-style `#` line comments are allowed
  hash_line_comments: bool,
}

impl Default for CommentSettings {
  fn default() -> Self {
    Self::all()
  }
}

impl CommentSettings {
  /// Enable all comment Styles
  pub const fn all() -> Self {
    Self {
      block_comments: true,
      slash_line_comments: true,
      hash_line_comments: true,
    }
  }
  /// Only allow line comments starting with `#`
  pub const fn hash_only() -> Self {
    Self {
      hash_line_comments: true,
      block_comments: false,
      slash_line_comments: false,
    }
  }
  /// Only allow "c-style" comments.
  ///
  /// Specifically, line comments beginning with `//` and
  /// block comment like `/* ... */`.
  pub const fn c_style() -> Self {
    Self {
      block_comments: true,
      slash_line_comments: true,
      hash_line_comments: false,
    }
  }

  /// Create a new `StripComments` for `input`, using these settings.
  ///
  /// Transform `input` into a [`Read`] that strips out comments.
  /// The types of comments to support are determined by the configuration of
  /// `self`.
  #[inline]
  pub fn strip_comments<I: Read>(self, input: I) -> StripComments<I> {
    StripComments::with_settings(self, input)
  }
}

fn top(c: &mut u8, settings: &CommentSettings) -> State {
  match *c {
    b'"' => InString,
    b'/' => {
      *c = b' ';
      InComment
    }
    b'#' if settings.hash_line_comments => {
      *c = b' ';
      InLineComment
    }
    _ => Top,
  }
}

fn in_string(c: u8) -> State {
  match c {
    b'"' => Top,
    b'\\' => StringEscape,
    _ => InString,
  }
}

fn in_comment(c: &mut u8, settings: &CommentSettings) -> Result<State> {
  let new_state = match c {
    b'*' if settings.block_comments => InBlockComment,
    b'/' if settings.slash_line_comments => InLineComment,
    _ => invalid_data!(),
  };
  *c = b' ';
  Ok(new_state)
}

fn in_block_comment(c: &mut u8) -> State {
  let old = *c;
  *c = b' ';
  if old == b'*' {
    MaybeCommentEnd
  } else {
    InBlockComment
  }
}

fn maybe_comment_end(c: &mut u8) -> State {
  let old = *c;
  *c = b' ';
  if old == b'/' {
    *c = b' ';
    Top
  } else {
    InBlockComment
  }
}

fn in_line_comment(c: &mut u8) -> State {
  if *c == b'\n' {
    Top
  } else {
    *c = b' ';
    InLineComment
  }
}

#[cfg(test)]
mod tests {
  use std::io::{ErrorKind, Read};

  use super::*;

  fn strip_string(input: &str) -> String {
    let mut out = String::new();
    let count = StripComments::new(input.as_bytes())
      .read_to_string(&mut out)
      .unwrap();
    assert_eq!(count, input.len());
    out
  }

  #[test]
  fn block_comments() {
    let json = r#"{/* Comment */"hi": /** abc */ "bye"}"#;
    let stripped = strip_string(json);
    assert_eq!(stripped, r#"{             "hi":            "bye"}"#);
  }

  #[test]
  fn block_comments_with_possible_end() {
    let json = r#"{/* Comment*PossibleEnd */"hi": /** abc */ "bye"}"#;
    let stripped = strip_string(json);
    assert_eq!(
      stripped,
      r#"{                         "hi":            "bye"}"#
    );
  }

  #[test]
  fn line_comments() {
    let json = r#"{
            // line comment
            "a": 4,
            # another
        }"#;

    let expected = "{
                           \n            \"a\": 4,
                     \n        }";

    assert_eq!(strip_string(json), expected);
  }

  #[test]
  fn incomplete_string() {
    let json = r#""foo"#;
    let mut stripped = String::new();

    let err = StripComments::new(json.as_bytes())
      .read_to_string(&mut stripped)
      .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
  }

  #[test]
  fn incomplete_comment() {
    let json = r#"/* foo "#;
    let mut stripped = String::new();

    let err = StripComments::new(json.as_bytes())
      .read_to_string(&mut stripped)
      .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
  }

  #[test]
  fn incomplete_comment2() {
    let json = r#"/* foo *"#;
    let mut stripped = String::new();

    let err = StripComments::new(json.as_bytes())
      .read_to_string(&mut stripped)
      .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
  }

  #[test]
  fn no_hash_comments() {
    let json = r#"# bad comment
        {"a": "b"}"#;
    let mut stripped = String::new();
    CommentSettings::c_style()
      .strip_comments(json.as_bytes())
      .read_to_string(&mut stripped)
      .unwrap();
    assert_eq!(stripped, json);
  }

  #[test]
  fn no_slash_line_comments() {
    let json = r#"// bad comment
        {"a": "b"}"#;
    let mut stripped = String::new();
    let err = CommentSettings::hash_only()
      .strip_comments(json.as_bytes())
      .read_to_string(&mut stripped)
      .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
  }

  #[test]
  fn no_block_comments() {
    let json = r#"/* bad comment */ {"a": "b"}"#;
    let mut stripped = String::new();
    let err = CommentSettings::hash_only()
      .strip_comments(json.as_bytes())
      .read_to_string(&mut stripped)
      .unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
  }

  #[test]
  fn strip_in_place() {
    let mut json = String::from(r#"{/* Comment */"hi": /** abc */ "bye"}"#);
    strip_comments_in_place(&mut json, Default::default(), false).unwrap();
    assert_eq!(json, r#"{             "hi":            "bye"}"#);
  }

  #[test]
  fn trailing_comma() {
    let mut json = String::from(
      r#"{
            "a1": [1,],
            "a2": [1,/* x */],
            "a3": [
                1, // x
            ],
            "o1": {v:1,},
            "o2": {v:1,/* x */},
            "o3": {
                "v":1, // x
            },
            # another
        }"#,
    );
    strip_comments_in_place(&mut json, Default::default(), true).unwrap();

    let expected = r#"{
            "a1": [1 ],
            "a2": [1        ],
            "a3": [
                1      
            ],
            "o1": {v:1 },
            "o2": {v:1        },
            "o3": {
                "v":1      
            } 
                     
        }"#;

    assert_eq!(json, expected);
  }
}
