use std::collections::HashSet;

use html5ever::{expanded_name, local_name, namespace_url, ns, ExpandedName};
use oxvg_optimiser::RemoveUnknownsAndDefaults;
use typed_arena::Arena;
use xml5ever::tendril::StrTendril;

use crate::arena::{Node, NodeData, Ref};

pub fn optimize<'arena>(arena: &'arena Arena<Node<'arena>>, dom: &'arena Node<'arena>) {
  dom.walk(&mut |node| match &node.data {
    NodeData::Element { name, .. } => {
      // https://html.spec.whatwg.org/#elements-3
      match name.expanded() {
        expanded_name!(html "a") => {
          trim(node, expanded_name!("", "href"));
          space_separated(node, expanded_name!("", "ping"));
          unordered_space_separated_set(node, expanded_name!("", "rel"));
          enumerated(node, expanded_name!("", "target"), "_self");
        }
        expanded_name!(html "area") => {
          trim(node, expanded_name!("", "href"));
          space_separated(node, expanded_name!("", "ping"));
          unordered_space_separated_set(node, expanded_name!("", "rel"));
          enumerated(node, expanded_name!("", "shape"), "rect");
          enumerated(node, expanded_name!("", "target"), "_self");
        }
        expanded_name!(html "audio") => {
          trim(node, expanded_name!("", "src"));
          case_insensitive(node, expanded_name!("", "preload"));
          case_insensitive(node, expanded_name!("", "crossorigin"));
          boolean(node, expanded_name!("", "autoplay"));
          boolean(node, expanded_name!("", "loop"));
          boolean(node, expanded_name!("", "muted"));
          boolean(node, expanded_name!("", "controls"));
        }
        expanded_name!(html "base") => {
          trim(node, expanded_name!("", "href"));
          enumerated(node, expanded_name!("", "target"), "_self");
        }
        expanded_name!(html "blockquote") => {
          trim(node, expanded_name!("", "cite"));
        }
        expanded_name!(html "button") => {
          trim(node, expanded_name!("", "formaction"));
          enumerated(
            node,
            expanded_name!("", "formenctype"),
            "application/x-www-form-urlencoded",
          );
          enumerated(node, expanded_name!("", "formmethod"), "get");
          // enumerated(node, expanded_name!("", "popovertargetaction"), "toggle");
          enumerated(node, expanded_name!("", "type"), "submit");
          boolean(node, expanded_name!("", "disabled"));
          boolean(node, expanded_name!("", "formnovalidate"));
        }
        expanded_name!(html "canvas") => {
          trim_with_default(node, expanded_name!("", "height"), "150");
          trim_with_default(node, expanded_name!("", "width"), "300");
        }
        expanded_name!(html "col") => {
          trim_with_default(node, expanded_name!("", "span"), "1");
        }
        expanded_name!(html "colgroup") => {
          trim_with_default(node, expanded_name!("", "span"), "1");
        }
        expanded_name!(html "del") => {
          trim(node, expanded_name!("", "cite"));
        }
        expanded_name!(html "details") => {
          boolean(node, expanded_name!("", "open"));
        }
        expanded_name!(html "dialog") => {
          boolean(node, expanded_name!("", "open"));
        }
        expanded_name!(html "embed") => {
          trim(node, expanded_name!("", "src"));
          trim(node, expanded_name!("", "height"));
          trim(node, expanded_name!("", "width"));
        }
        expanded_name!(html "fieldset") => {
          boolean(node, expanded_name!("", "disabled"));
        }
        expanded_name!(html "form") => {
          case_insensitive(node, expanded_name!("", "accept-charset"));
          trim(node, expanded_name!("", "action"));
          enumerated(node, expanded_name!("", "autocomplete"), "on");
          enumerated(
            node,
            expanded_name!("", "enctype"),
            "application/x-www-form-urlencoded",
          );
          enumerated(node, expanded_name!("", "method"), "get");
          unordered_space_separated_set(node, expanded_name!("", "rel"));
          enumerated(node, expanded_name!("", "target"), "_self");
          boolean(node, expanded_name!("", "novalidate"));
        }
        expanded_name!(html "head") => {
          remove_whitespace(node);
        }
        expanded_name!(html "html") => {
          remove_whitespace(node);
        }
        expanded_name!(html "iframe") => {
          trim(node, expanded_name!("", "src"));
          unordered_space_separated_set(node, expanded_name!("", "sandbox"));
          enumerated(node, expanded_name!("", "referrerpolicy"), "");
          enumerated(node, expanded_name!("", "loading"), "eager");
          trim(node, expanded_name!("", "height"));
          trim(node, expanded_name!("", "width"));
          boolean(node, expanded_name!("", "allowfullscreen"));
        }
        expanded_name!(html "img") => {
          trim(node, expanded_name!("", "src"));
          comma_separated(node, expanded_name!("", "srcset"));
          comma_separated(node, expanded_name!("", "sizes"));
          enumerated(node, expanded_name!("", "referrerpolicy"), "");
          enumerated(node, expanded_name!("", "decoding"), "auto");
          enumerated(node, expanded_name!("", "loading"), "eager");
          enumerated(node, expanded_name!("", "fetchpriority"), "auto");
          trim_with_default(node, expanded_name!("", "height"), "150");
          trim_with_default(node, expanded_name!("", "width"), "300");
          case_insensitive(node, expanded_name!("", "crossorigin"));
          boolean(node, expanded_name!("", "ismap"));
        }
        expanded_name!(html "input") => {
          comma_separated(node, expanded_name!("", "accept"));
          ordered_space_separated_set(node, expanded_name!("", "autocomplete"));
          // enumerated(node, expanded_name!("", "colorspace"), "limited-srgb");
          trim(node, expanded_name!("", "formaction"));
          // boolean(node, expanded_name!("", "alpha"));
          enumerated(
            node,
            expanded_name!("", "formenctype"),
            "application/x-www-form-urlencoded",
          );
          enumerated(node, expanded_name!("", "formmethod"), "get");
          trim(node, expanded_name!("", "src"));
          enumerated(node, expanded_name!("", "type"), "text");
          trim(node, expanded_name!("", "height"));
          trim(node, expanded_name!("", "width"));
          trim(node, expanded_name!("", "minlength"));
          trim_with_default(node, expanded_name!("", "size"), "20");
          case_insensitive(node, expanded_name!("", "inputmode"));
          boolean(node, expanded_name!("", "checked"));
          boolean(node, expanded_name!("", "disabled"));
          boolean(node, expanded_name!("", "formnovalidate"));
          boolean(node, expanded_name!("", "multiple"));
          boolean(node, expanded_name!("", "readonly"));
          boolean(node, expanded_name!("", "required"));
        }
        expanded_name!(html "ins") => {
          trim(node, expanded_name!("", "cite"));
        }
        expanded_name!(html "link") => {
          trim(node, expanded_name!("", "href"));
          unordered_space_separated_set(node, expanded_name!("", "rel"));
          enumerated(node, expanded_name!("", "referrerpolicy"), "");
          // unordered_space_separated_set(node, expanded_name!("", "blocking"));
          enumerated(node, expanded_name!("", "fetchpriority"), "auto");
          unordered_space_separated_set(node, expanded_name!("", "sizes"));
          comma_separated(node, expanded_name!("", "media"));
          case_insensitive(node, expanded_name!("", "crossorigin"));
          boolean(node, expanded_name!("", "disabled"));
          if let Some(rel) = node.get_attribute(expanded_name!("", "rel")) {
            if rel.as_ref() == "stylesheet" {
              trim_with_default(node, expanded_name!("", "type"), "text/css");
              trim_with_default(node, expanded_name!("", "media"), "all");
            }
          }
        }
        expanded_name!(html "meta") => {
          enumerated(node, expanded_name!("", "charset"), "utf-8");
          if let NodeData::Element { attrs, .. } = &node.data {
            if attrs.borrow().is_empty() {
              node.detach();
            }
          }
        }
        expanded_name!(html "meter") => {
          trim(node, expanded_name!("", "high"));
          trim(node, expanded_name!("", "low"));
          trim_with_default(node, expanded_name!("", "min"), "0");
          trim_with_default(node, expanded_name!("", "max"), "1");
          trim(node, expanded_name!("", "optimum"));
        }
        expanded_name!(html "object") => {
          trim(node, expanded_name!("", "data"));
          trim(node, expanded_name!("", "height"));
          trim(node, expanded_name!("", "width"));
        }
        expanded_name!(html "ol") => {
          trim_with_default(node, expanded_name!("", "start"), "1");
          trim_with_default(node, expanded_name!("", "type"), "1");
          boolean(node, expanded_name!("", "reversed"));
        }
        expanded_name!(html "optgroup") => {
          boolean(node, expanded_name!("", "disabled"));
        }
        expanded_name!(html "option") => {
          boolean(node, expanded_name!("", "disabled"));
          boolean(node, expanded_name!("", "selected"));
        }
        expanded_name!(html "output") => {
          unordered_space_separated_set(node, expanded_name!("", "for"));
        }
        expanded_name!(html "progress") => {
          trim_with_default(node, expanded_name!("", "max"), "1");
        }
        expanded_name!(html "q") => {
          trim(node, expanded_name!("", "cite"));
        }
        expanded_name!(html "script") => {
          trim(node, expanded_name!("", "src"));
          if let Some(ty) = node.get_attribute(expanded_name!("", "type")) {
            // https://mimesniff.spec.whatwg.org/#javascript-mime-type
            if ty.is_empty()
              || ty.eq_ignore_ascii_case("application/ecmascript")
              || ty.eq_ignore_ascii_case("application/javascript")
              || ty.eq_ignore_ascii_case("application/x-ecmascript")
              || ty.eq_ignore_ascii_case("application/x-javascript")
              || ty.eq_ignore_ascii_case("text/ecmascript")
              || ty.eq_ignore_ascii_case("text/javascript")
              || ty.eq_ignore_ascii_case("text/javascript1.0")
              || ty.eq_ignore_ascii_case("text/javascript1.1")
              || ty.eq_ignore_ascii_case("text/javascript1.2")
              || ty.eq_ignore_ascii_case("text/javascript1.3")
              || ty.eq_ignore_ascii_case("text/javascript1.4")
              || ty.eq_ignore_ascii_case("text/javascript1.5")
              || ty.eq_ignore_ascii_case("text/jscript")
              || ty.eq_ignore_ascii_case("text/livescript")
              || ty.eq_ignore_ascii_case("text/x-ecmascript")
              || ty.eq_ignore_ascii_case("text/x-javascript")
            {
              node.remove_attribute(expanded_name!("", "type"));
            }
          }
          enumerated(node, expanded_name!("", "referrerpolicy"), "");
          // unordered_space_separated_set(node, expanded_name!("", "blocking"));
          enumerated(node, expanded_name!("", "fetchpriority"), "auto");
          enumerated(node, expanded_name!("", "charset"), "utf-8");
          case_insensitive(node, expanded_name!("", "crossorigin"));
          boolean(node, expanded_name!("", "async"));
          boolean(node, expanded_name!("", "defer"));
          boolean(node, expanded_name!("", "nomodule"));
        }
        expanded_name!(html "select") => {
          trim(node, expanded_name!("", "size"));
          boolean(node, expanded_name!("", "disabled"));
          boolean(node, expanded_name!("", "multiple"));
          boolean(node, expanded_name!("", "required"));
        }
        expanded_name!(html "source") => {
          trim(node, expanded_name!("", "src"));
          comma_separated(node, expanded_name!("", "srcset"));
          comma_separated(node, expanded_name!("", "sizes"));
          trim(node, expanded_name!("", "height"));
          trim(node, expanded_name!("", "width"));
          comma_separated(node, expanded_name!("", "media"));
        }
        expanded_name!(html "style") => {
          comma_separated(node, expanded_name!("", "media"));
          trim_with_default(node, expanded_name!("", "type"), "text/css");
          trim_with_default(node, expanded_name!("", "media"), "all");
        }
        expanded_name!(html "td") => {
          trim_with_default(node, expanded_name!("", "colspan"), "1");
          trim_with_default(node, expanded_name!("", "rowspan"), "1");
          unordered_space_separated_set(node, expanded_name!("", "headers"));
          case_insensitive(node, expanded_name!("", "scope"));
        }
        expanded_name!(html "textarea") => {
          ordered_space_separated_set(node, expanded_name!("", "autocomplete"));
          enumerated(node, expanded_name!("", "wrap"), "soft");
          trim_with_default(node, expanded_name!("", "cols"), "20");
          trim_with_default(node, expanded_name!("", "rows"), "2");
          trim(node, expanded_name!("", "minlength"));
          case_insensitive(node, expanded_name!("", "inputmode"));
          boolean(node, expanded_name!("", "disabled"));
          boolean(node, expanded_name!("", "readonly"));
          boolean(node, expanded_name!("", "required"));
        }
        expanded_name!(html "th") => {
          trim_with_default(node, expanded_name!("", "colspan"), "1");
          trim_with_default(node, expanded_name!("", "rowspan"), "1");
          unordered_space_separated_set(node, expanded_name!("", "headers"));
          case_insensitive(node, expanded_name!("", "scope"));
        }
        expanded_name!(html "track") => {
          enumerated(node, expanded_name!("", "kind"), "metadata");
          trim(node, expanded_name!("", "src"));
          boolean(node, expanded_name!("", "default"));
        }
        expanded_name!(html "video") => {
          trim(node, expanded_name!("", "src"));
          trim(node, expanded_name!("", "poster"));
          trim(node, expanded_name!("", "height"));
          trim(node, expanded_name!("", "width"));
          case_insensitive(node, expanded_name!("", "crossorigin"));
          case_insensitive(node, expanded_name!("", "preload"));
          boolean(node, expanded_name!("", "autoplay"));
          boolean(node, expanded_name!("", "controls"));
          boolean(node, expanded_name!("", "loop"));
          boolean(node, expanded_name!("", "muted"));
          // boolean(node, expanded_name!("", "playsinline"));
        }
        expanded_name!(svg "svg") => {
          remove_whitespace(node);
          let node = crate::oxvg::OxvgNode { node, arena };
          let jobs = oxvg_optimiser::Jobs::<crate::oxvg::OxvgNode> {
            // These defaults can break CSS selectors.
            convert_shape_to_path: None,
            // Additional defaults to preserve accessibility information.
            remove_title: None,
            remove_desc: None,
            remove_unknowns_and_defaults: Some(RemoveUnknownsAndDefaults {
              keep_aria_attrs: true,
              keep_role_attr: true,
              ..Default::default()
            }),
            // Do not minify ids or remove unreferenced elements in
            // inline SVGs because they could actually be referenced
            // by a separate inline SVG.
            cleanup_ids: None,
            remove_hidden_elems: None,
            ..Default::default()
          };
          match jobs.run(&node, &oxvg_ast::visitor::Info::default()) {
            Err(_err) => {}
            Ok(()) => {}
          }
        }
        _ => {
          if name.ns == ns!(svg)
            && !matches!(
              name.local,
              local_name!("text")
                | local_name!("textPath")
                | local_name!("tspan")
                | local_name!("script")
                | local_name!("style")
            )
          {
            remove_whitespace(node);
          }
        }
      }

      // https://html.spec.whatwg.org/#global-attributes
      ordered_space_separated_set(node, expanded_name!("", "accesskey"));
      boolean(node, expanded_name!("", "autofocus"));
      unordered_space_separated_set(node, expanded_name!("", "class"));
      trim(node, expanded_name!("", "style"));
      // enumerated(node, expanded_name!("", "autocorrect"), "on");
      // boolean(node, expanded_name!("", "inert"));
      trim(node, expanded_name!("", "itemid"));
      unordered_space_separated_set(node, expanded_name!("", "itemprop"));
      unordered_space_separated_set(node, expanded_name!("", "itemref"));
      boolean(node, expanded_name!("", "itemscope"));
      unordered_space_separated_set(node, expanded_name!("", "itemtype"));

      if let Some(value) = node.get_attribute(expanded_name!("", "contenteditable")) {
        if value.as_ref() == "true" {
          node.set_attribute(expanded_name!("", "contenteditable"), "");
        }
      }
    }
    NodeData::Comment { contents } => {
      let is_conditional_comment =
        (contents.starts_with("[if ") && contents.ends_with("]")) || contents.as_ref() == "[endif]";
      if !is_conditional_comment {
        node.detach();
      }
    }
    _ => {}
  });
}

fn trim<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
      node.remove_attribute(attr);
    } else if trimmed.len() != value.len() {
      node.set_attribute(attr, trimmed);
    }
  }
}

fn trim_with_default<'arena>(node: Ref<'arena>, attr: ExpandedName, default: &str) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed == default {
      node.remove_attribute(attr);
    } else if trimmed.len() != value.len() {
      node.set_attribute(attr, trimmed);
    }
  }
}

// https://html.spec.whatwg.org/#space-separated-tokens
fn space_separated<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let result = serialize_space_separated(value.split_whitespace(), value.len());
    if result.is_empty() {
      node.remove_attribute(attr);
    } else {
      node.set_attribute(attr, &result);
    }
  }
}

fn serialize_space_separated<'a>(
  items: impl Iterator<Item = &'a str> + 'a,
  capacity: usize,
) -> StrTendril {
  let mut result = StrTendril::with_capacity(capacity as u32);
  for item in items {
    if !result.is_empty() {
      result.push_char(' ');
    }
    result.push_slice(item);
  }
  result
}

fn unordered_space_separated_set<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let mut items = value.split_whitespace().collect::<Vec<_>>();
    items.sort();
    items.dedup();
    if items.is_empty() {
      node.remove_attribute(attr);
      return;
    }

    let result = serialize_space_separated(items.into_iter(), value.len());
    node.set_attribute(attr, &result);
  }
}

fn ordered_space_separated_set<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let mut items = value.split_whitespace().collect::<Vec<_>>();
    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(*item));
    if items.is_empty() {
      node.remove_attribute(attr);
      return;
    }

    let result = serialize_space_separated(items.into_iter(), value.len());
    node.set_attribute(attr, &result);
  }
}

fn comma_separated<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let mut result = StrTendril::with_capacity(value.len() as u32);
    for item in value.split(',') {
      if !result.is_empty() {
        result.push_char(',');
      }
      let item = item.trim();
      if item.is_empty() {
        continue;
      }
      result.push_slice(item);
    }
    if result.is_empty() {
      node.remove_attribute(attr);
    } else {
      node.set_attribute(attr, &result);
    }
  }
}

fn case_insensitive<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    let lower = value.to_lowercase();
    if value.as_ref() != lower {
      node.set_attribute(attr, &lower);
    }
  }
}

fn enumerated<'arena>(node: Ref<'arena>, attr: ExpandedName, default: &str) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    if value.eq_ignore_ascii_case(default) {
      node.remove_attribute(attr);
      return;
    }

    let lower = value.to_lowercase();
    if value.as_ref() != lower {
      node.set_attribute(attr, &lower);
    }
  }
}

fn boolean<'arena>(node: Ref<'arena>, attr: ExpandedName) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    if value.eq_ignore_ascii_case(&attr.local) {
      node.set_attribute(attr, "");
    }
  }
}

fn remove_whitespace<'arena>(node: Ref<'arena>) {
  let mut child = node.first_child.get();
  while let Some(c) = child {
    child = c.next_sibling.get();
    if let NodeData::Text { contents } = &c.data {
      let text = contents.borrow();
      let trimmed = text.trim();
      if trimmed.is_empty() {
        c.detach();
      } else {
        let mut result = StrTendril::with_capacity(trimmed.len() as u32);
        for word in trimmed.split_whitespace() {
          if !result.is_empty() {
            result.push_char(' ');
          }
          result.push_slice(word);
        }
        drop(text);
        *contents.borrow_mut() = result;
      }
    }
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

    optimize(&arena, dom);

    let arena = Arena::new();
    let expected = parse_document(Sink::new(&arena), ParseOpts::default())
      .from_utf8()
      .one(expected.as_bytes());

    assert_eq!(dom, expected);
  }

  #[test]
  fn test_optimize() {
    test(
      "<a href=' http://google.com ' ping = '  a   b c' rel='  b  a  c ' target='_self'>Test</a>",
      "<a href='http://google.com' ping='a b c' rel='a b c'>Test</a>",
    );
    test(
      "<a class=' foo  bar baz '>click</a>",
      "<a class='bar baz foo'>click</a>",
    );
    test(
      "<a class='foo bar foo'>click</a>",
      "<a class='bar foo'>click</a>",
    );
    test(
      "<area href=' http://google.com ' ping = '  a   b c' rel='  b  a  c ' target='_self' shape='rect'>Test</area>",
      "<area href='http://google.com' ping='a b c' rel='a b c'>Test</area>",
    );
    test(
      "<audio loop='' autoplay='autoplay' muted>",
      "<audio loop autoplay muted>",
    );
    test(
      "<base href='  foo.html ' target='_blank'>",
      "<base href='foo.html' target=_blank>",
    );
    test(
      "<blockquote cite=' foo.html  '>Test</blockquote>",
      "<blockquote cite='foo.html'>Test</blockquote>",
    );
    test(
      "<button formaction=' yoo.cgi ' formenctype='application/x-www-form-urlencoded' formmethod='GET' type='submit' disabled='disabled'>Test</button>",
      "<button formaction='yoo.cgi' disabled>Test</button>"
    );
    test(
      "<canvas width=300 height=150></canvas>",
      "<canvas></canvas>",
    );
    test(
      "<form method=GET target=_self novalidate='novalidate'></form>",
      "<form novalidate></form>",
    );
    test("<input type=text>", "<input>");
    test(
      "<script type='application/javascript'></script>",
      "<script></script>",
    );
    test("<style type='text/css'></style>", "<style></style>");
    test("<style media=all></style>", "<style></style>");
    test(
      "<link rel=stylesheet media=all href=foo.css>",
      "<link rel=stylesheet href=foo.css>",
    );
    test("<div><!-- foo -->Test</div>", "<div>Test</div>");
    test(
      "<!--[if IE 8]><link href='ie8only.css' rel='stylesheet'><![endif]-->",
      "<!--[if IE 8]><link href='ie8only.css' rel='stylesheet'><![endif]-->",
    );
    test("<div class='' style=''>Test</div>", "<div>Test</div>");
  }

  #[test]
  fn test_whitespace() {
    // Remove whitespace in the html and head elements.
    // Extra lines at the end are due to the parser adding whitespace outside the body/html to the body.
    test(
      r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Test</title>
  </head>
  <body>
    <p>Test</p>
    <p>Foo</p>
  </body>
</html>
"#,
      r#"<!doctype html><html><head><title>Test</title></head><body>
    <p>Test</p>
    <p>Foo</p>
  

</body></html>"#,
    );
  }
}
