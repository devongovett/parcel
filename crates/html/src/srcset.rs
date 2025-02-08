/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::iter::Peekable;

#[derive(Clone, Copy, Debug)]
enum ParseState {
  InDescriptor,
  InParens,
  AfterDescriptor,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageSource {
  pub url: String,
  pub descriptor: Descriptor,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Descriptor {
  pub width: Option<u32>,
  pub density: Option<f64>,
}

impl std::fmt::Display for ImageSource {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.url)?;
    if self.descriptor.width.is_some() || self.descriptor.density.is_some() {
      write!(f, " {}", self.descriptor)?;
    }
    Ok(())
  }
}

impl std::fmt::Display for Descriptor {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    if let Some(width) = self.width {
      write!(f, "{}w", width)?;
    }
    if let Some(density) = self.density {
      write!(f, "{}x", density)?;
    }
    Ok(())
  }
}

/// Parse an `srcset` attribute:
/// <https://html.spec.whatwg.org/multipage/#parsing-a-srcset-attribute>.
pub fn parse_srcset(input: &str) -> Vec<ImageSource> {
  // > 1. Let input be the value passed to this algorithm.
  // > 2. Let position be a pointer into input, initially pointing at the start of the string.
  let mut current_index = 0;

  // > 3. Let candidates be an initially empty source set.
  let mut candidates = vec![];
  while current_index < input.len() {
    let remaining_string = &input[current_index..];

    // > 4. Splitting loop: Collect a sequence of code points that are ASCII whitespace or
    // > U+002C COMMA characters from input given position. If any U+002C COMMA
    // > characters were collected, that is a parse error.
    let mut collected_comma = false;
    let (collected_characters, string_after_whitespace) =
      collect_sequence_characters(remaining_string, |character| {
        if *character == ',' {
          collected_comma = true;
        }
        *character == ',' || character.is_ascii_whitespace()
      });
    if collected_comma {
      return Vec::new();
    }

    // Add the length of collected whitespace, to find the start of the URL we are going
    // to parse.
    current_index += collected_characters.len();

    // > 5. If position is past the end of input, return candidates.
    if string_after_whitespace.is_empty() {
      return candidates;
    }

    // 6. Collect a sequence of code points that are not ASCII whitespace from input
    // given position, and let that be url.
    let (url, _) =
      collect_sequence_characters(string_after_whitespace, |c| !char::is_ascii_whitespace(c));

    // Add the length of `url` that we will parse to advance the index of the next part
    // of the string to prase.
    current_index += url.len();

    // 7. Let descriptors be a new empty list.
    let mut descriptors = Vec::new();

    // > 8. If url ends with U+002C (,), then:
    // >    1. Remove all trailing U+002C COMMA characters from url. If this removed
    // >       more than one character, that is a parse error.
    if url.ends_with(',') {
      let image_source = ImageSource {
        url: url.trim_end_matches(',').into(),
        descriptor: Descriptor {
          width: None,
          density: None,
        },
      };
      candidates.push(image_source);
      continue;
    }

    // Otherwise:
    // > 8.1. Descriptor tokenizer: Skip ASCII whitespace within input given position.
    let descriptors_string = &input[current_index..];
    let (spaces, descriptors_string) =
      collect_sequence_characters(descriptors_string, |character| {
        character.is_ascii_whitespace()
      });
    current_index += spaces.len();

    // > 8.2. Let current descriptor be the empty string.
    let mut current_descriptor = String::new();

    // > 8.3. Let state be "in descriptor".
    let mut state = ParseState::InDescriptor;

    // > 8.4. Let c be the character at position. Do the following depending on the value of
    // > state. For the purpose of this step, "EOF" is a special character representing
    // > that position is past the end of input.
    let mut characters = descriptors_string.chars();
    let mut character = characters.next();
    if let Some(character) = character {
      current_index += character.len_utf8();
    }

    loop {
      match (state, character) {
        (ParseState::InDescriptor, Some(character)) if character.is_ascii_whitespace() => {
          // > If current descriptor is not empty, append current descriptor to
          // > descriptors and let current descriptor be the empty string. Set
          // > state to after descriptor.
          if !current_descriptor.is_empty() {
            descriptors.push(current_descriptor);
            current_descriptor = String::new();
            state = ParseState::AfterDescriptor;
          }
        }
        (ParseState::InDescriptor, Some(',')) => {
          // > Advance position to the next character in input. If current descriptor
          // > is not empty, append current descriptor to descriptors. Jump to the
          // > step labeled descriptor parser.
          if !current_descriptor.is_empty() {
            descriptors.push(current_descriptor);
          }
          break;
        }
        (ParseState::InDescriptor, Some('(')) => {
          // > Append c to current descriptor. Set state to in parens.
          current_descriptor.push('(');
          state = ParseState::InParens;
        }
        (ParseState::InDescriptor, Some(character)) => {
          // > Append c to current descriptor.
          current_descriptor.push(character);
        }
        (ParseState::InDescriptor, None) => {
          // > If current descriptor is not empty, append current descriptor to
          // > descriptors. Jump to the step labeled descriptor parser.
          if !current_descriptor.is_empty() {
            descriptors.push(current_descriptor);
          }
          break;
        }
        (ParseState::InParens, Some(')')) => {
          // > Append c to current descriptor. Set state to in descriptor.
          current_descriptor.push(')');
          state = ParseState::InDescriptor;
        }
        (ParseState::InParens, Some(character)) => {
          // Append c to current descriptor.
          current_descriptor.push(character);
        }
        (ParseState::InParens, None) => {
          // > Append current descriptor to descriptors. Jump to the step
          // > labeled descriptor parser.
          descriptors.push(current_descriptor);
          break;
        }
        (ParseState::AfterDescriptor, Some(character)) if character.is_ascii_whitespace() => {
          // > Stay in this state.
        }
        (ParseState::AfterDescriptor, Some(_)) => {
          // > Set state to in descriptor. Set position to the previous
          // > character in input.
          state = ParseState::InDescriptor;
          continue;
        }
        (ParseState::AfterDescriptor, None) => {
          // > Jump to the step labeled descriptor parser.
          break;
        }
      }

      character = characters.next();
      if let Some(character) = character {
        current_index += character.len_utf8();
      }
    }

    // > 9. Descriptor parser: Let error be no.
    let mut error = false;
    // > 10. Let width be absent.
    let mut width: Option<u32> = None;
    // > 11. Let density be absent.
    let mut density: Option<f64> = None;
    // > 12. Let future-compat-h be absent.
    let mut future_compat_h: Option<u32> = None;

    // > 13. For each descriptor in descriptors, run the appropriate set of steps from
    // > the following list:
    for descriptor in descriptors.into_iter() {
      let Some(last_character) = descriptor.chars().last() else {
        break;
      };

      let first_part_of_string = &descriptor[0..descriptor.len() - last_character.len_utf8()];
      match last_character {
        // > If the descriptor consists of a valid non-negative integer followed by a
        // > U+0077 LATIN SMALL LETTER W character
        // > 1. If the user agent does not support the sizes attribute, let error be yes.
        // > 2. If width and density are not both absent, then let error be yes.
        // > 3. Apply the rules for parsing non-negative integers to the descriptor.
        // >    If the result is 0, let error be yes. Otherwise, let width be the result.
        'w' if density.is_none() && width.is_none() => {
          match parse_integer(first_part_of_string.chars()) {
            Ok(number) if number > 0 => {
              width = Some(number as u32);
              continue;
            }
            _ => error = true,
          }
        }

        // > If the descriptor consists of a valid floating-point number followed by a
        // > U+0078 LATIN SMALL LETTER X character
        // > 1. If width, density and future-compat-h are not all absent, then let
        // >    error be yes.
        // > 2. Apply the rules for parsing floating-point number values to the
        // >    descriptor. If the result is less than 0, let error be yes. Otherwise, let
        // >    density be the result.
        //
        // The HTML specification has a procedure for parsing floats that is different enough from
        // the one that stylo uses, that it's better to use Rust's float parser here. This is
        // what Gecko does, but it also checks to see if the number is a valid HTML-spec compliant
        // number first. Not doing that means that we might be parsing numbers that otherwise
        // wouldn't parse.
        // TODO: Do what Gecko does and first validate the number passed to the Rust float parser.
        'x' if width.is_none() && density.is_none() && future_compat_h.is_none() => {
          match first_part_of_string.parse::<f64>() {
            Ok(number) if number.is_normal() && number > 0. => {
              density = Some(number);
              continue;
            }
            _ => error = true,
          }
        }

        // > If the descriptor consists of a valid non-negative integer followed by a
        // > U+0068 LATIN SMALL LETTER H character
        // >   This is a parse error.
        // > 1. If future-compat-h and density are not both absent, then let error be
        // >    yes.
        // > 2. Apply the rules for parsing non-negative integers to the descriptor.
        // >    If the result is 0, let error be yes. Otherwise, let future-compat-h be the
        // >    result.
        'h' if future_compat_h.is_none() && density.is_none() => {
          match parse_integer(first_part_of_string.chars()) {
            Ok(number) if number > 0 => {
              future_compat_h = Some(number as u32);
              continue;
            }
            _ => error = true,
          }
        }

        // > Anything else
        // >  Let error be yes.
        _ => error = true,
      }

      if error {
        break;
      }
    }

    // > 14. If future-compat-h is not absent and width is absent, let error be yes.
    if future_compat_h.is_some() && width.is_none() {
      error = true;
    }

    if !error {
      let image_source = ImageSource {
        url: url.into(),
        descriptor: Descriptor { width, density },
      };
      candidates.push(image_source);
    }
  }
  candidates
}

fn collect_sequence_characters(s: &str, mut predicate: impl FnMut(&char) -> bool) -> (&str, &str) {
  let i = s.find(|ch| !predicate(&ch)).unwrap_or(s.len());
  (&s[0..i], &s[i..])
}

/// A static slice of characters.
type StaticCharVec = &'static [char];

/// A "space character" according to:
///
/// <https://html.spec.whatwg.org/multipage/#space-character>
static HTML_SPACE_CHARACTERS: StaticCharVec =
  &['\u{0020}', '\u{0009}', '\u{000a}', '\u{000c}', '\u{000d}'];

/// Parse an integer according to
/// <https://html.spec.whatwg.org/multipage/#rules-for-parsing-integers> or
/// <https://html.spec.whatwg.org/multipage/#rules-for-parsing-non-negative-integers>
fn parse_integer<T: Iterator<Item = char>>(input: T) -> Result<i64, ()> {
  let mut input = input
    .skip_while(|c| HTML_SPACE_CHARACTERS.iter().any(|s| s == c))
    .peekable();

  let sign = match input.peek() {
    None => return Err(()),
    Some(&'-') => {
      input.next();
      -1
    }
    Some(&'+') => {
      input.next();
      1
    }
    Some(_) => 1,
  };

  let (value, _) = read_numbers(input);

  value.and_then(|value| value.checked_mul(sign)).ok_or(())
}

/// Read a set of ascii digits and read them into a number.
fn read_numbers<I: Iterator<Item = char>>(mut iter: Peekable<I>) -> (Option<i64>, usize) {
  match iter.peek() {
    Some(c) if is_ascii_digit(c) => (),
    _ => return (None, 0),
  }

  iter
    .take_while(is_ascii_digit)
    .map(|d| d as i64 - '0' as i64)
    .fold((Some(0i64), 0), |accumulator, d| {
      let digits = accumulator
        .0
        .and_then(|accumulator| accumulator.checked_mul(10))
        .and_then(|accumulator| accumulator.checked_add(d));
      (digits, accumulator.1 + 1)
    })
}

/// Character is ascii digit
fn is_ascii_digit(c: &char) -> bool {
  match *c {
    '0'..='9' => true,
    _ => false,
  }
}
