// Copyright 2014-2017 The html5ever Project Developers. See the
// COPYRIGHT file at the top-level directory of this distribution.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

// Modified from html5ever to add minification support.

use crate::arena::{NodeData, Ref};
use html5ever::{expanded_name, Attribute, LocalName, QualName};
use html5ever::{local_name, namespace_url, ns};
use std::io::{self, Write};

pub fn serialize<'arena, Wr>(writer: Wr, node: Ref<'arena>, opts: SerializeOpts) -> io::Result<()>
where
  Wr: Write,
{
  let mut ser = HtmlSerializer::new(writer, opts.clone());
  ser.serialize_node(node)
}

#[derive(Clone)]
pub struct SerializeOpts {
  /// Is scripting enabled? Default: true
  pub scripting_enabled: bool,

  /// If the serializer is asked to serialize an invalid tree, the default
  /// behavior is to panic in the event that an `end_elem` is created without a
  /// matching `start_elem`. Setting this to true will prevent those panics by
  /// creating a default parent on the element stack. No extra start elem will
  /// actually be written. Default: false
  pub create_missing_parent: bool,
}

impl Default for SerializeOpts {
  fn default() -> SerializeOpts {
    SerializeOpts {
      scripting_enabled: true,
      create_missing_parent: false,
    }
  }
}

#[derive(Default)]
struct ElemInfo {
  html_name: Option<LocalName>,
  ignore_children: bool,
}

pub struct HtmlSerializer<Wr: Write> {
  pub writer: Wr,
  opts: SerializeOpts,
  stack: Vec<ElemInfo>,
}

fn tagname(name: &QualName) -> LocalName {
  match name.ns {
    ns!(html) | ns!(mathml) | ns!(svg) => (),
    _ => {
      // FIXME(#122)
      // warn!("node with weird namespace {:?}", ns);
    }
  }

  name.local.clone()
}

impl<Wr: Write> HtmlSerializer<Wr> {
  pub fn new(writer: Wr, opts: SerializeOpts) -> Self {
    HtmlSerializer {
      writer,
      opts,
      stack: vec![ElemInfo {
        html_name: None,
        ignore_children: false,
      }],
    }
  }

  fn parent(&mut self) -> &mut ElemInfo {
    if self.stack.is_empty() {
      if self.opts.create_missing_parent {
        // warn!("ElemInfo stack empty, creating new parent");
        self.stack.push(Default::default());
      } else {
        panic!("no parent ElemInfo")
      }
    }
    self.stack.last_mut().unwrap()
  }

  fn write_escaped(&mut self, text: &str, attr_mode: bool) -> io::Result<()> {
    for c in text.chars() {
      match c {
        '&' => self.writer.write_all(b"&amp;"),
        '\u{00A0}' => self.writer.write_all(b"&nbsp;"),
        '"' if attr_mode => self.writer.write_all(b"&quot;"),
        '<' if !attr_mode => self.writer.write_all(b"&lt;"),
        '>' if !attr_mode => self.writer.write_all(b"&gt;"),
        c => self.writer.write_fmt(format_args!("{c}")),
      }?;
    }
    Ok(())
  }

  fn serialize_node<'arena>(&mut self, node: Ref<'arena>) -> io::Result<()> {
    match &node.data {
      NodeData::Element {
        name,
        attrs,
        template_contents,
        ..
      } => {
        self.start_elem(node, name, &*attrs.borrow())?;

        let mut child = node.first_child.get();
        while let Some(n) = child {
          self.serialize_node(n)?;
          child = n.next_sibling.get();
        }

        if let Some(template_contents) = template_contents {
          self.serialize_node(template_contents)?;
        }

        self.end_elem(node, name)?;
      }
      NodeData::Comment { contents } => {
        self.write_comment(contents)?;
      }
      NodeData::Doctype { name, .. } => {
        self.write_doctype(name)?;
      }
      NodeData::Document => {
        let mut child = node.first_child.get();
        while let Some(n) = child {
          self.serialize_node(n)?;
          child = n.next_sibling.get();
        }
      }
      NodeData::ProcessingInstruction { target, contents } => {
        self.write_processing_instruction(target, contents.borrow().as_ref())?;
      }
      NodeData::Text { contents } => {
        self.write_text(contents.borrow().as_ref())?;
      }
    }
    Ok(())
  }

  fn start_elem<'arena, 'a>(
    &mut self,
    node: Ref<'arena>,
    name: &QualName,
    attrs: &Vec<Attribute>,
  ) -> io::Result<()> {
    let html_name = match name.ns {
      ns!(html) => Some(name.local.clone()),
      _ => None,
    };

    if self.parent().ignore_children {
      self.stack.push(ElemInfo {
        html_name,
        ignore_children: true,
      });
      return Ok(());
    }

    if attrs.is_empty() && can_omit_start_tag(node, name) {
      self.stack.push(ElemInfo {
        html_name,
        ignore_children: false,
      });
      return Ok(());
    }

    self.writer.write_all(b"<")?;
    self.writer.write_all(tagname(&name).as_bytes())?;
    let mut quoted = false;
    for attr in attrs {
      self.writer.write_all(b" ")?;

      match attr.name.ns {
        ns!() => (),
        ns!(xml) => self.writer.write_all(b"xml:")?,
        ns!(xmlns) => {
          if name.local != local_name!("xmlns") {
            self.writer.write_all(b"xmlns:")?;
          }
        }
        ns!(xlink) => self.writer.write_all(b"xlink:")?,
        _ => {
          // FIXME(#122)
          // warn!("attr with weird namespace {:?}", ns);
          self.writer.write_all(b"unknown_namespace:")?;
        }
      }

      self.writer.write_all(attr.name.local.as_bytes())?;
      if !attr.value.is_empty() {
        if !attr.value.contains(|c: char| {
          c.is_ascii_whitespace() || matches!(c, '"' | '\'' | '=' | '<' | '>' | '`' | '\u{00A0}')
        }) {
          self.writer.write_all(b"=")?;
          self.writer.write_all(attr.value.as_bytes())?;
          quoted = false;
        } else {
          self.writer.write_all(b"=\"")?;
          self.write_escaped(&attr.value, true)?;
          self.writer.write_all(b"\"")?;
          quoted = true;
        }
      }
    }

    let self_closing =
      (name.ns == ns!(svg) || name.ns == ns!(mathml)) && node.first_child.get().is_none();
    if self_closing {
      // If last attribute is not quoted, a space is required.
      // Otherwise the / will be parsed as part of the attribute value.
      if !quoted {
        self.writer.write_all(b" />")?;
      } else {
        self.writer.write_all(b"/>")?;
      }
    } else {
      self.writer.write_all(b">")?;
    }

    let ignore_children = name.ns == ns!(html)
      && matches!(
        name.local,
        local_name!("area")
          | local_name!("base")
          | local_name!("basefont")
          | local_name!("bgsound")
          | local_name!("br")
          | local_name!("col")
          | local_name!("embed")
          | local_name!("frame")
          | local_name!("hr")
          | local_name!("img")
          | local_name!("input")
          | local_name!("keygen")
          | local_name!("link")
          | local_name!("meta")
          | local_name!("param")
          | local_name!("source")
          | local_name!("track")
          | local_name!("wbr")
      );

    self.stack.push(ElemInfo {
      html_name,
      ignore_children: self_closing || ignore_children,
    });

    Ok(())
  }

  fn end_elem<'a>(&mut self, node: Ref<'a>, name: &QualName) -> io::Result<()> {
    let info = match self.stack.pop() {
      Some(info) => info,
      None if self.opts.create_missing_parent => {
        // warn!("missing ElemInfo, creating default.");
        Default::default()
      }
      _ => panic!("no ElemInfo"),
    };
    if info.ignore_children {
      return Ok(());
    }

    if can_omit_end_tag(node, name) {
      return Ok(());
    }

    self.writer.write_all(b"</")?;
    self.writer.write_all(tagname(&name).as_bytes())?;
    self.writer.write_all(b">")
  }

  fn write_text(&mut self, text: &str) -> io::Result<()> {
    let escape = match self.parent().html_name {
      Some(local_name!("style"))
      | Some(local_name!("script"))
      | Some(local_name!("xmp"))
      | Some(local_name!("iframe"))
      | Some(local_name!("noembed"))
      | Some(local_name!("noframes"))
      | Some(local_name!("plaintext")) => false,

      Some(local_name!("noscript")) => !self.opts.scripting_enabled,

      _ => true,
    };

    if escape {
      self.write_escaped(text, false)
    } else {
      self.writer.write_all(text.as_bytes())
    }
  }

  fn write_comment(&mut self, text: &str) -> io::Result<()> {
    self.writer.write_all(b"<!--")?;
    self.writer.write_all(text.as_bytes())?;
    self.writer.write_all(b"-->")
  }

  fn write_doctype(&mut self, name: &str) -> io::Result<()> {
    self.writer.write_all(b"<!DOCTYPE ")?;
    self.writer.write_all(name.as_bytes())?;
    self.writer.write_all(b">")
  }

  fn write_processing_instruction(&mut self, target: &str, data: &str) -> io::Result<()> {
    self.writer.write_all(b"<?")?;
    self.writer.write_all(target.as_bytes())?;
    self.writer.write_all(b" ")?;
    self.writer.write_all(data.as_bytes())?;
    self.writer.write_all(b">")
  }
}

// https://html.spec.whatwg.org/multipage/syntax.html#optional-tags
fn can_omit_start_tag(node: Ref<'_>, name: &QualName) -> bool {
  match name.expanded() {
    expanded_name!(html "html") => !node.first_child_is_comment(),
    expanded_name!(html "head") => match node.first_child.get() {
      None => true,
      Some(first) => matches!(first.data, NodeData::Element { .. }),
    },
    expanded_name!(html "body") => match node.first_child.get() {
      None => true,
      Some(first) => {
        !(matches!(first.data, NodeData::Comment { .. }) || first.starts_with_whitespace())
          && !matches!(&node.data, NodeData::Element { name, .. }  if matches!(name.expanded(), expanded_name!(html "meta") | expanded_name!(html "noscript") | expanded_name!(html "link") | expanded_name!(html "script") | expanded_name!(html "style") | expanded_name!(html "template")))
      }
    },
    expanded_name!(html "colgroup") => {
      // A colgroup element's start tag may be omitted if the first thing inside the colgroup element is a col element,
      // and if the element is not immediately preceded by another colgroup element whose end tag has been omitted.
      // (It can't be omitted if the element is empty.)
      if node.first_child_is(expanded_name!(html "col")) {
        let prev_omitted = match node.previous_sibling.get() {
          None => false,
          Some(prev) => {
            if let NodeData::Element { name, .. } = &prev.data {
              name.expanded() == expanded_name!(html "colgroup") && can_omit_end_tag(prev, name)
            } else {
              false
            }
          }
        };
        !prev_omitted
      } else {
        false
      }
    }
    expanded_name!(html "tbody") => {
      // A tbody element's start tag may be omitted if the first thing inside the tbody element is a tr element,
      // and if the element is not immediately preceded by a tbody, thead, or tfoot element whose end tag has
      // been omitted. (It can't be omitted if the element is empty.)
      if node.first_child_is(expanded_name!(html "tr")) {
        let prev_omitted = match node.previous_sibling.get() {
          None => false,
          Some(prev) => {
            if let NodeData::Element { name, .. } = &prev.data {
              matches!(
                name.expanded(),
                expanded_name!(html "tbody")
                  | expanded_name!(html "thead")
                  | expanded_name!(html "tfoot")
              ) && can_omit_end_tag(prev, name)
            } else {
              false
            }
          }
        };
        !prev_omitted
      } else {
        false
      }
    }
    _ => false,
  }
}

// https://html.spec.whatwg.org/multipage/syntax.html#optional-tags
fn can_omit_end_tag(node: Ref<'_>, name: &QualName) -> bool {
  match name.expanded() {
    expanded_name!(html "html") => !node.next_sibling_is_comment(),
    expanded_name!(html "head") => !node.next_sibling_is_comment_or_whitespace(),
    expanded_name!(html "body") => !node.next_sibling_is_comment(),
    expanded_name!(html "li") => {
      node.is_last_child() || node.next_sibling_is(expanded_name!(html "li"))
    }
    expanded_name!(html "dt") => {
      node.next_sibling_is(expanded_name!(html "dt"))
        || node.next_sibling_is(expanded_name!(html "dd"))
    }
    expanded_name!(html "dd") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "dd"))
        || node.next_sibling_is(expanded_name!(html "dt"))
    }
    expanded_name!(html "p") => match node.next_sibling.get() {
      None => {
        if let Some(parent) = node.parent.get() {
          if let NodeData::Element { name, .. } = &parent.data {
            !matches!(
              name.expanded(),
              expanded_name!(html "a")
                | expanded_name!(html "audio")
                | expanded_name!(html "del")
                | expanded_name!(html "ins")
                | expanded_name!(html "map")
                | expanded_name!(html "noscript")
                | expanded_name!(html "video")
            ) || name.local.contains('-')
          } else {
            false
          }
        } else {
          false
        }
      }
      Some(next) => {
        if let NodeData::Element { name, .. } = &next.data {
          matches!(
            name.expanded(),
            expanded_name!(html "address")
              | expanded_name!(html "article")
              | expanded_name!(html "aside")
              | expanded_name!(html "blockquote")
              | expanded_name!(html "details")
              | expanded_name!(html "dialog")
              | expanded_name!(html "div")
              | expanded_name!(html "dl")
              | expanded_name!(html "fieldset")
              | expanded_name!(html "figcaption")
              | expanded_name!(html "figure")
              | expanded_name!(html "footer")
              | expanded_name!(html "form")
              | expanded_name!(html "h1")
              | expanded_name!(html "h2")
              | expanded_name!(html "h3")
              | expanded_name!(html "h4")
              | expanded_name!(html "h5")
              | expanded_name!(html "h6")
              | expanded_name!(html "header")
              | expanded_name!(html "hgroup")
              | expanded_name!(html "hr")
              | expanded_name!(html "main")
              | expanded_name!(html "menu")
              | expanded_name!(html "nav")
              | expanded_name!(html "ol")
              | expanded_name!(html "p")
              | expanded_name!(html "pre")
              | expanded_name!(html "search")
              | expanded_name!(html "section")
              | expanded_name!(html "table")
              | expanded_name!(html "ul")
          )
        } else {
          false
        }
      }
    },
    expanded_name!(html "rt") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "rt"))
        || node.next_sibling_is(expanded_name!(html "rp"))
    }
    expanded_name!(html "rp") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "rt"))
        || node.next_sibling_is(expanded_name!(html "rp"))
    }
    expanded_name!(html "optgroup") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "optgroup"))
        || node.next_sibling_is(expanded_name!(html "hr"))
    }
    expanded_name!(html "option") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "option"))
        || node.next_sibling_is(expanded_name!(html "optgroup"))
        || node.next_sibling_is(expanded_name!(html "hr"))
    }
    expanded_name!(html "colgroup") => !node.next_sibling_is_comment_or_whitespace(),
    expanded_name!(html "caption") => !node.next_sibling_is_comment_or_whitespace(),
    expanded_name!(html "thead") => {
      node.next_sibling_is(expanded_name!(html "tbody"))
        || node.next_sibling_is(expanded_name!(html "tfoot"))
    }
    expanded_name!(html "tbody") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "tbody"))
        || node.next_sibling_is(expanded_name!(html "tfoot"))
    }
    expanded_name!(html "tfoot") => node.is_last_child(),
    expanded_name!(html "tr") => {
      node.is_last_child() || node.next_sibling_is(expanded_name!(html "tr"))
    }
    expanded_name!(html "td") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "td"))
        || node.next_sibling_is(expanded_name!(html "th"))
    }
    expanded_name!(html "th") => {
      node.is_last_child()
        || node.next_sibling_is(expanded_name!(html "td"))
        || node.next_sibling_is(expanded_name!(html "th"))
    }

    _ => false,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::arena::Sink;
  use html5ever::tendril::TendrilSink;
  use html5ever::{parse_document, ParseOpts};
  use typed_arena::Arena;

  fn test(input: &str, expected: &str) {
    let arena = Arena::new();
    let dom = parse_document(Sink::new(&arena), ParseOpts::default())
      .from_utf8()
      .one(input.as_bytes());

    let mut vec = Vec::new();
    serialize(&mut vec, dom, SerializeOpts::default()).expect("Serialize error");
    assert_eq!(std::str::from_utf8(&vec).unwrap(), expected);

    let arena = Arena::new();
    let result = parse_document(Sink::new(&arena), ParseOpts::default())
      .from_utf8()
      .one(vec.as_slice());

    assert_eq!(dom, result);
  }

  #[test]
  fn test_serialize() {
    test(
      "<!DOCTYPE HTML><html><head><title>Hello</title></head><body><p>Welcome to this example.</p></body></html>", 
      "<!DOCTYPE html><title>Hello</title><p>Welcome to this example."
    );
    test(
      "<!DOCTYPE HTML><html lang=\"en\"><head><title>Hello</title></head><body class=\"demo\"><p>Welcome to this example.</p></body></html>", 
      "<!DOCTYPE html><html lang=en><title>Hello</title><body class=demo><p>Welcome to this example."
    );
    test(
      "<!DOCTYPE HTML><html><!-- comment --><head><title>Hello</title></head><body><p>Welcome to this example.</p></body></html>", 
      "<!DOCTYPE html><html><!-- comment --><title>Hello</title><p>Welcome to this example."
    );
    test(
      "<!DOCTYPE HTML><html><head><title>Hello</title></head><body><p>Welcome to this example.</p></body></html><!-- comment -->", 
      "<!DOCTYPE html><title>Hello</title><p>Welcome to this example.</html><!-- comment -->"
    );
    test("<html><head></head><body>Test</body></html>", "Test");
    test(
      "<html><head> <title>Test</title> </head><body>Test</body></html>",
      "<head> <title>Test</title> Test",
    );
    test(
      "<!DOCTYPE HTML><html><body><ul><li>Foo</li><li>Bar</li></ul></body></html>",
      "<!DOCTYPE html><ul><li>Foo<li>Bar</ul>",
    );
    test(
      "<!DOCTYPE HTML><html><body><dl><dt>Foo</dt><dd>Bar</dd><dt>Baz</dt><dd>Qux</dd></dl></body></html>",
      "<!DOCTYPE html><dl><dt>Foo<dd>Bar<dt>Baz<dd>Qux</dl>",
    );
    test(
      "<!DOCTYPE HTML><html><body><select><option>Foo</option><option>Bar</option></select></body></html>",
      "<!DOCTYPE html><select><option>Foo<option>Bar</select>",
    );
    test(
      "<!DOCTYPE HTML><html><body><table><caption>Test</caption><colgroup><col><col></colgroup><thead><tr><th>Foo</th><th>Bar</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr><tr><td>A</td><td>B</td></tr></tbody></table></body></html>",
      "<!DOCTYPE html><table><caption>Test<col><col><thead><tr><th>Foo<th>Bar<tbody><tr><td>A<td>B<tr><td>A<td>B</table>"
    );
    test(
      "<template><div>test</div></template>",
      "<template><div>test</div></template>",
    );
  }

  #[test]
  fn test_attrs() {
    test(
      "<button disabled=''>Test</button>",
      "<button disabled>Test</button>",
    );
    test(
      "<div class='foo bar'>Test</div>",
      "<div class=\"foo bar\">Test</div>",
    );
    test("<div class='foo'>Test</div>", "<div class=foo>Test</div>");
  }

  #[test]
  fn test_svg() {
    test(
      "<body><svg><rect width=100 height=100></rect></svg></body>",
      "<svg><rect width=100 height=100 /></svg>",
    );
  }
}
