//! An implementation url.to_file_path that behaves like Unix on Wasm
#![allow(clippy::items_after_test_module)]

#[cfg(any(target_arch = "wasm32", test))]
use std::ffi::OsStr;
use std::path::PathBuf;

use url::Url;

use crate::specifier::SpecifierError;

pub fn url_to_path(input: &str) -> Result<PathBuf, SpecifierError> {
  let url = Url::parse(input)?;

  #[cfg(target_arch = "wasm32")]
  {
    Ok(to_file_path(&url).map_err(|_| SpecifierError::InvalidFileUrl)?)
  }

  #[cfg(not(target_arch = "wasm32"))]
  {
    url
      .to_file_path()
      .map_err(|_| SpecifierError::InvalidFileUrl)
  }
}

// From std::os::unix::ffi::os_str.rs (also used on WASI)
#[cfg(any(target_arch = "wasm32", test))]
#[inline]
fn os_str_from_bytes(slice: &[u8]) -> &OsStr {
  unsafe { std::mem::transmute(slice) }
}

#[cfg(test)]
mod test {
  use std::path::PathBuf;

  use url::Url;

  use crate::url_to_path::to_file_path;

  #[test]
  fn test() {
    let f = "/x/y/z/foo.js";
    assert_eq!(
      to_file_path(&Url::parse(&format!("file://{f}")).unwrap()),
      Ok(PathBuf::from(f))
    );
    let f = "/bar.js";
    assert_eq!(
      to_file_path(&Url::parse(&format!("file://{f}")).unwrap()),
      Ok(PathBuf::from(f))
    );
  }
}

// The functions below are copied from https://github.com/servo/rust-url/blob/74b8694568d8eb936e339a7d726bda46881dcd9d/url/src/lib.rs

// Copyright (c) 2013-2022 The rust-url developers

// Permission is hereby granted, free of charge, to any
// person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the
// Software without restriction, including without
// limitation the rights to use, copy, modify, merge,
// publish, distribute, sublicense, and/or sell copies of
// the Software, and to permit persons to whom the Software
// is furnished to do so, subject to the following
// conditions:

// The above copyright notice and this permission notice
// shall be included in all copies or substantial portions
// of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
// ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
// PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
// SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
// CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
// IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

#[cfg(any(target_arch = "wasm32", test))]
pub fn to_file_path(this: &Url) -> Result<PathBuf, ()> {
  use url::Host;

  if let Some(segments) = this.path_segments() {
    let host = match this.host() {
      None | Some(Host::Domain("localhost")) => None,
      // Some(_) if cfg!(windows) && this.scheme() == "file" => {
      //   Some(&this.serialization[this.host_start as usize..this.host_end as usize])
      // }
      _ => return Err(()),
    };

    return file_url_segments_to_pathbuf(host, segments);
  }
  Err(())
}

#[allow(clippy::manual_is_ascii_check)]
#[cfg(any(target_arch = "wasm32", test))]
fn file_url_segments_to_pathbuf(
  host: Option<&str>,
  segments: core::str::Split<'_, char>,
) -> Result<PathBuf, ()> {
  use percent_encoding::percent_decode;

  if host.is_some() {
    return Err(());
  }

  let mut bytes =
  // if cfg!(target_os = "redox") {
  //   b"file:".to_vec()
  // } else {
    Vec::new()
  // }
  ;

  for segment in segments {
    bytes.push(b'/');
    bytes.extend(percent_decode(segment.as_bytes()));
  }

  // A windows drive letter must end with a slash.
  if bytes.len() > 2
    && matches!(bytes[bytes.len() - 2], b'a'..=b'z' | b'A'..=b'Z')
    && matches!(bytes[bytes.len() - 1], b':' | b'|')
  {
    bytes.push(b'/');
  }

  let os_str = os_str_from_bytes(&bytes);
  let path = PathBuf::from(os_str);

  debug_assert!(
    path.has_root(), // path.is_absolute(),
    "to_file_path() failed to produce an absolute Path"
  );

  Ok(path)
}
