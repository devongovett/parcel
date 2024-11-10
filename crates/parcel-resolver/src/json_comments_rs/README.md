# json-comments-rs

[![Build Status](https://github.com/tmccombs/json-comments-rs/actions/workflows/build/badge.svg?branch=main)](https://github.com/tmccombs/json-comments-rs/actions)
[![Docs](https://docs.rs/json_comments/badge.svg)](https://docs.rs/json_comments/)

`json_comments` is a library to strip out comments from JSON-like text. By processing text
through a [`StripComments`] adapter first, it is possible to use a standard JSON parser (such
as [serde_json](https://crates.io/crates/serde_json) with quasi-json input that contains
comments.

In fact, this code makes few assumptions about the input and could probably be used to strip
comments out of other types of code as well, provided that strings use double quotes and
backslashes are used for escapes in strings.

The following types of comments are supported:

- C style block comments (`/* ... */`)
- C style line comments (`// ...`)
- Shell style line comments (`# ...`)

## Example using serde_json

```rust
use serde_json::{Result, Value};
use json_comments::StripComments;

fn main() -> Result<()> {
// Some JSON input data as a &str. Maybe this comes form the user.
let data = r#"
    {
        "name": /* full */ "John Doe",
        "age": 43,
        "phones": [
            "+44 1234567", // work phone
            "+44 2345678"  // home phone
        ]
    }"#;

// Strip the comments from the input (use `as_bytes()` to get a `Read`).
let stripped = StripComments::new(data.as_bytes());
// Parse the string of data into serde_json::Value.
let v: Value = serde_json::from_reader(stripped)?;

println!("Please call {} at the number {}", v["name"], v["phones"][0]);

Ok(())
}
```
