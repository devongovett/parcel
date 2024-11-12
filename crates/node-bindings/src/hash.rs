#![allow(clippy::new_without_default)]

use std::hash::Hasher;

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use xxhash_rust::xxh3::{xxh3_64, Xxh3};

#[napi]
pub fn hash_string(s: String) -> String {
  let s = s.as_bytes();
  let res = xxh3_64(s);
  format!("{:016x}", res)
}

#[napi]
pub fn hash_buffer(buf: Buffer) -> String {
  let res = xxh3_64(&buf);
  format!("{:016x}", res)
}

#[napi]
pub struct Hash {
  hash: Xxh3,
}

#[napi]
impl Hash {
  #[napi(constructor)]
  pub fn new() -> Self {
    Hash { hash: Xxh3::new() }
  }

  #[napi]
  pub fn write_string(&mut self, s: String) {
    self.hash.write(s.as_bytes());
  }

  #[napi]
  pub fn write_buffer(&mut self, buf: Buffer) {
    self.hash.write(&buf);
  }

  #[napi]
  pub fn finish(&mut self) -> String {
    let res = self.hash.finish();
    format!("{:016x}", res)
  }
}
