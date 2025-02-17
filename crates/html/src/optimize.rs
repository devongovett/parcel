use std::collections::HashSet;

use html5ever::{expanded_name, local_name, namespace_url, ns, ExpandedName};
use oxvg_optimiser::RemoveUnknownsAndDefaults;
use typed_arena::Arena;
use xml5ever::tendril::StrTendril;

use crate::arena::{Node, NodeData, Ref};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeOptions {
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  collapse_attribute_whitespace: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  collapse_whitespace: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  deduplicate_attribute_values: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  remove_comments: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  remove_empty_attributes: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  minify_json: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  minify_svg: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  remove_redundant_attributes: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  collapse_boolean_attributes: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  normalize_attribute_values: bool,
  #[serde(default = "default_true", deserialize_with = "ok_or_default")]
  sort_attributes_with_lists: bool,
}

fn default_true() -> bool {
  true
}

fn ok_or_default<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
  D: serde::Deserializer<'de>,
{
  Ok(serde::Deserialize::deserialize(deserializer).unwrap_or(true))
}

impl Default for OptimizeOptions {
  fn default() -> Self {
    OptimizeOptions {
      collapse_attribute_whitespace: true,
      collapse_whitespace: true,
      deduplicate_attribute_values: true,
      remove_comments: true,
      remove_empty_attributes: true,
      minify_json: true,
      minify_svg: true,
      remove_redundant_attributes: true,
      collapse_boolean_attributes: true,
      normalize_attribute_values: true,
      sort_attributes_with_lists: true,
    }
  }
}

pub fn optimize<'arena>(
  arena: &'arena Arena<Node<'arena>>,
  dom: &'arena Node<'arena>,
  options: OptimizeOptions,
) {
  dom.walk(&mut |node| match &node.data {
    NodeData::Element { name, .. } => {
      // https://html.spec.whatwg.org/#elements-3
      match name.expanded() {
        expanded_name!(html "a") => {
          trim(node, expanded_name!("", "href"), &options);
          space_separated(node, expanded_name!("", "ping"), &options);
          unordered_space_separated_set(node, expanded_name!("", "rel"), &options);
          enumerated(node, expanded_name!("", "target"), "_self", &options);
        }
        expanded_name!(html "area") => {
          trim(node, expanded_name!("", "href"), &options);
          space_separated(node, expanded_name!("", "ping"), &options);
          unordered_space_separated_set(node, expanded_name!("", "rel"), &options);
          enumerated(node, expanded_name!("", "shape"), "rect", &options);
          enumerated(node, expanded_name!("", "target"), "_self", &options);
        }
        expanded_name!(html "audio") => {
          trim(node, expanded_name!("", "src"), &options);
          case_insensitive(node, expanded_name!("", "preload"), &options);
          case_insensitive(node, expanded_name!("", "crossorigin"), &options);
          boolean(node, expanded_name!("", "autoplay"), &options);
          boolean(node, expanded_name!("", "loop"), &options);
          boolean(node, expanded_name!("", "muted"), &options);
          boolean(node, expanded_name!("", "controls"), &options);
        }
        expanded_name!(html "base") => {
          trim(node, expanded_name!("", "href"), &options);
          enumerated(node, expanded_name!("", "target"), "_self", &options);
        }
        expanded_name!(html "blockquote") => {
          trim(node, expanded_name!("", "cite"), &options);
        }
        expanded_name!(html "button") => {
          trim(node, expanded_name!("", "formaction"), &options);
          enumerated(
            node,
            expanded_name!("", "formenctype"),
            "application/x-www-form-urlencoded",
            &options,
          );
          enumerated(node, expanded_name!("", "formmethod"), "get", &options);
          // enumerated(node, expanded_name!("", "popovertargetaction"), "toggle", &options);
          enumerated(node, expanded_name!("", "type"), "submit", &options);
          boolean(node, expanded_name!("", "disabled"), &options);
          boolean(node, expanded_name!("", "formnovalidate"), &options);
        }
        expanded_name!(html "canvas") => {
          trim_with_default(node, expanded_name!("", "height"), "150", &options);
          trim_with_default(node, expanded_name!("", "width"), "300", &options);
        }
        expanded_name!(html "col") => {
          trim_with_default(node, expanded_name!("", "span"), "1", &options);
        }
        expanded_name!(html "colgroup") => {
          trim_with_default(node, expanded_name!("", "span"), "1", &options);
        }
        expanded_name!(html "del") => {
          trim(node, expanded_name!("", "cite"), &options);
        }
        expanded_name!(html "details") => {
          boolean(node, expanded_name!("", "open"), &options);
        }
        expanded_name!(html "dialog") => {
          boolean(node, expanded_name!("", "open"), &options);
        }
        expanded_name!(html "embed") => {
          trim(node, expanded_name!("", "src"), &options);
          trim(node, expanded_name!("", "height"), &options);
          trim(node, expanded_name!("", "width"), &options);
        }
        expanded_name!(html "fieldset") => {
          boolean(node, expanded_name!("", "disabled"), &options);
        }
        expanded_name!(html "form") => {
          case_insensitive(node, expanded_name!("", "accept-charset"), &options);
          trim(node, expanded_name!("", "action"), &options);
          enumerated(node, expanded_name!("", "autocomplete"), "on", &options);
          enumerated(
            node,
            expanded_name!("", "enctype"),
            "application/x-www-form-urlencoded",
            &options,
          );
          enumerated(node, expanded_name!("", "method"), "get", &options);
          unordered_space_separated_set(node, expanded_name!("", "rel"), &options);
          enumerated(node, expanded_name!("", "target"), "_self", &options);
          boolean(node, expanded_name!("", "novalidate"), &options);
        }
        expanded_name!(html "head") => {
          remove_whitespace(node, &options);
        }
        expanded_name!(html "html") => {
          remove_whitespace(node, &options);
        }
        expanded_name!(html "iframe") => {
          trim(node, expanded_name!("", "src"), &options);
          unordered_space_separated_set(node, expanded_name!("", "sandbox"), &options);
          enumerated(node, expanded_name!("", "referrerpolicy"), "", &options);
          enumerated(node, expanded_name!("", "loading"), "eager", &options);
          trim(node, expanded_name!("", "height"), &options);
          trim(node, expanded_name!("", "width"), &options);
          boolean(node, expanded_name!("", "allowfullscreen"), &options);
        }
        expanded_name!(html "img") => {
          trim(node, expanded_name!("", "src"), &options);
          comma_separated(node, expanded_name!("", "srcset"), &options);
          comma_separated(node, expanded_name!("", "sizes"), &options);
          enumerated(node, expanded_name!("", "referrerpolicy"), "", &options);
          enumerated(node, expanded_name!("", "decoding"), "auto", &options);
          enumerated(node, expanded_name!("", "loading"), "eager", &options);
          enumerated(node, expanded_name!("", "fetchpriority"), "auto", &options);
          trim_with_default(node, expanded_name!("", "height"), "150", &options);
          trim_with_default(node, expanded_name!("", "width"), "300", &options);
          case_insensitive(node, expanded_name!("", "crossorigin"), &options);
          boolean(node, expanded_name!("", "ismap"), &options);
        }
        expanded_name!(html "input") => {
          comma_separated(node, expanded_name!("", "accept"), &options);
          ordered_space_separated_set(node, expanded_name!("", "autocomplete"), &options);
          // enumerated(node, expanded_name!("", "colorspace"), "limited-srgb", &options);
          trim(node, expanded_name!("", "formaction"), &options);
          // boolean(node, expanded_name!("", "alpha"), &options);
          enumerated(
            node,
            expanded_name!("", "formenctype"),
            "application/x-www-form-urlencoded",
            &options,
          );
          enumerated(node, expanded_name!("", "formmethod"), "get", &options);
          trim(node, expanded_name!("", "src"), &options);
          enumerated(node, expanded_name!("", "type"), "text", &options);
          trim(node, expanded_name!("", "height"), &options);
          trim(node, expanded_name!("", "width"), &options);
          trim(node, expanded_name!("", "minlength"), &options);
          trim_with_default(node, expanded_name!("", "size"), "20", &options);
          case_insensitive(node, expanded_name!("", "inputmode"), &options);
          boolean(node, expanded_name!("", "checked"), &options);
          boolean(node, expanded_name!("", "disabled"), &options);
          boolean(node, expanded_name!("", "formnovalidate"), &options);
          boolean(node, expanded_name!("", "multiple"), &options);
          boolean(node, expanded_name!("", "readonly"), &options);
          boolean(node, expanded_name!("", "required"), &options);
        }
        expanded_name!(html "ins") => {
          trim(node, expanded_name!("", "cite"), &options);
        }
        expanded_name!(html "link") => {
          trim(node, expanded_name!("", "href"), &options);
          unordered_space_separated_set(node, expanded_name!("", "rel"), &options);
          enumerated(node, expanded_name!("", "referrerpolicy"), "", &options);
          // unordered_space_separated_set(node, expanded_name!("", "blocking"), &options);
          enumerated(node, expanded_name!("", "fetchpriority"), "auto", &options);
          unordered_space_separated_set(node, expanded_name!("", "sizes"), &options);
          comma_separated(node, expanded_name!("", "media"), &options);
          case_insensitive(node, expanded_name!("", "crossorigin"), &options);
          boolean(node, expanded_name!("", "disabled"), &options);
          if let Some(rel) = node.get_attribute(expanded_name!("", "rel")) {
            if rel.as_ref() == "stylesheet" {
              trim_with_default(node, expanded_name!("", "type"), "text/css", &options);
              trim_with_default(node, expanded_name!("", "media"), "all", &options);
            }
          }
        }
        expanded_name!(html "meta") => {
          enumerated(node, expanded_name!("", "charset"), "utf-8", &options);
          if let NodeData::Element { attrs, .. } = &node.data {
            if attrs.borrow().is_empty() {
              node.detach();
            }
          }
        }
        expanded_name!(html "meter") => {
          trim(node, expanded_name!("", "high"), &options);
          trim(node, expanded_name!("", "low"), &options);
          trim_with_default(node, expanded_name!("", "min"), "0", &options);
          trim_with_default(node, expanded_name!("", "max"), "1", &options);
          trim(node, expanded_name!("", "optimum"), &options);
        }
        expanded_name!(html "object") => {
          trim(node, expanded_name!("", "data"), &options);
          trim(node, expanded_name!("", "height"), &options);
          trim(node, expanded_name!("", "width"), &options);
        }
        expanded_name!(html "ol") => {
          trim_with_default(node, expanded_name!("", "start"), "1", &options);
          trim_with_default(node, expanded_name!("", "type"), "1", &options);
          boolean(node, expanded_name!("", "reversed"), &options);
        }
        expanded_name!(html "optgroup") => {
          boolean(node, expanded_name!("", "disabled"), &options);
        }
        expanded_name!(html "option") => {
          boolean(node, expanded_name!("", "disabled"), &options);
          boolean(node, expanded_name!("", "selected"), &options);
        }
        expanded_name!(html "output") => {
          unordered_space_separated_set(node, expanded_name!("", "for"), &options);
        }
        expanded_name!(html "progress") => {
          trim_with_default(node, expanded_name!("", "max"), "1", &options);
        }
        expanded_name!(html "q") => {
          trim(node, expanded_name!("", "cite"), &options);
        }
        expanded_name!(html "script") => {
          trim(node, expanded_name!("", "src"), &options);
          if let Some(ty) = node.get_attribute(expanded_name!("", "type")) {
            // https://mimesniff.spec.whatwg.org/#javascript-mime-type
            if (ty.is_empty() && options.remove_empty_attributes)
              || ((ty.eq_ignore_ascii_case("application/ecmascript")
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
                || ty.eq_ignore_ascii_case("text/x-javascript"))
                && options.remove_redundant_attributes)
            {
              node.remove_attribute(expanded_name!("", "type"));
            } else if options.minify_json
              && (ty.ends_with("/json") || ty.ends_with("+json"))
              && node.get_attribute(expanded_name!("", "src")).is_none()
              && node
                .get_attribute(expanded_name!("", "integrity"))
                .is_none()
            {
              let content: Result<serde_json::Value, _> =
                serde_json::from_str(&node.text_content());
              if let Ok(content) = content {
                if let Ok(json) = serde_json::to_string(&content) {
                  node.set_text_content(arena, json.into());
                }
              }
            }
          }
          enumerated(node, expanded_name!("", "referrerpolicy"), "", &options);
          // unordered_space_separated_set(node, expanded_name!("", "blocking"), &options);
          enumerated(node, expanded_name!("", "fetchpriority"), "auto", &options);
          enumerated(node, expanded_name!("", "charset"), "utf-8", &options);
          case_insensitive(node, expanded_name!("", "crossorigin"), &options);
          boolean(node, expanded_name!("", "async"), &options);
          boolean(node, expanded_name!("", "defer"), &options);
          boolean(node, expanded_name!("", "nomodule"), &options);
        }
        expanded_name!(html "select") => {
          trim(node, expanded_name!("", "size"), &options);
          boolean(node, expanded_name!("", "disabled"), &options);
          boolean(node, expanded_name!("", "multiple"), &options);
          boolean(node, expanded_name!("", "required"), &options);
        }
        expanded_name!(html "source") => {
          trim(node, expanded_name!("", "src"), &options);
          comma_separated(node, expanded_name!("", "srcset"), &options);
          comma_separated(node, expanded_name!("", "sizes"), &options);
          trim(node, expanded_name!("", "height"), &options);
          trim(node, expanded_name!("", "width"), &options);
          comma_separated(node, expanded_name!("", "media"), &options);
        }
        expanded_name!(html "style") => {
          comma_separated(node, expanded_name!("", "media"), &options);
          trim_with_default(node, expanded_name!("", "type"), "text/css", &options);
          trim_with_default(node, expanded_name!("", "media"), "all", &options);
        }
        expanded_name!(html "td") => {
          trim_with_default(node, expanded_name!("", "colspan"), "1", &options);
          trim_with_default(node, expanded_name!("", "rowspan"), "1", &options);
          unordered_space_separated_set(node, expanded_name!("", "headers"), &options);
          case_insensitive(node, expanded_name!("", "scope"), &options);
        }
        expanded_name!(html "textarea") => {
          ordered_space_separated_set(node, expanded_name!("", "autocomplete"), &options);
          enumerated(node, expanded_name!("", "wrap"), "soft", &options);
          trim_with_default(node, expanded_name!("", "cols"), "20", &options);
          trim_with_default(node, expanded_name!("", "rows"), "2", &options);
          trim(node, expanded_name!("", "minlength"), &options);
          case_insensitive(node, expanded_name!("", "inputmode"), &options);
          boolean(node, expanded_name!("", "disabled"), &options);
          boolean(node, expanded_name!("", "readonly"), &options);
          boolean(node, expanded_name!("", "required"), &options);
        }
        expanded_name!(html "th") => {
          trim_with_default(node, expanded_name!("", "colspan"), "1", &options);
          trim_with_default(node, expanded_name!("", "rowspan"), "1", &options);
          unordered_space_separated_set(node, expanded_name!("", "headers"), &options);
          case_insensitive(node, expanded_name!("", "scope"), &options);
        }
        expanded_name!(html "track") => {
          enumerated(node, expanded_name!("", "kind"), "metadata", &options);
          trim(node, expanded_name!("", "src"), &options);
          boolean(node, expanded_name!("", "default"), &options);
        }
        expanded_name!(html "video") => {
          trim(node, expanded_name!("", "src"), &options);
          trim(node, expanded_name!("", "poster"), &options);
          trim(node, expanded_name!("", "height"), &options);
          trim(node, expanded_name!("", "width"), &options);
          case_insensitive(node, expanded_name!("", "crossorigin"), &options);
          case_insensitive(node, expanded_name!("", "preload"), &options);
          boolean(node, expanded_name!("", "autoplay"), &options);
          boolean(node, expanded_name!("", "controls"), &options);
          boolean(node, expanded_name!("", "loop"), &options);
          boolean(node, expanded_name!("", "muted"), &options);
          // boolean(node, expanded_name!("", "playsinline"), &options);
        }
        expanded_name!(svg "svg") => {
          remove_whitespace(node, &options);

          if options.minify_svg {
            // Synthesize a fake document node to act as the root of the SVG.
            let document = arena.alloc(Node::new(NodeData::Document, 0));
            document.first_child.set(Some(node));
            document.last_child.set(Some(node));
            let node = crate::oxvg::OxvgNode {
              node: document,
              arena,
            };

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
            remove_whitespace(node, &options);
          }
        }
      }

      // https://html.spec.whatwg.org/#global-attributes
      ordered_space_separated_set(node, expanded_name!("", "accesskey"), &options);
      boolean(node, expanded_name!("", "autofocus"), &options);
      unordered_space_separated_set(node, expanded_name!("", "class"), &options);
      trim(node, expanded_name!("", "style"), &options);
      // enumerated(node, expanded_name!("", "autocorrect"), "on", &options);
      // boolean(node, expanded_name!("", "inert"), &options);
      trim(node, expanded_name!("", "itemid"), &options);
      unordered_space_separated_set(node, expanded_name!("", "itemprop"), &options);
      unordered_space_separated_set(node, expanded_name!("", "itemref"), &options);
      boolean(node, expanded_name!("", "itemscope"), &options);
      unordered_space_separated_set(node, expanded_name!("", "itemtype"), &options);

      if let Some(value) = node.get_attribute(expanded_name!("", "contenteditable")) {
        if value.as_ref() == "true" && options.normalize_attribute_values {
          node.set_attribute(expanded_name!("", "contenteditable"), "");
        }
      }
    }
    NodeData::Comment { contents } => {
      if options.remove_comments {
        let is_conditional_comment = (contents.starts_with("[if ") && contents.ends_with("]"))
          || contents.as_ref() == "[endif]";
        if !is_conditional_comment {
          node.detach();
        }
      }
    }
    _ => {}
  });
}

pub fn optimize_svg<'arena>(arena: &'arena Arena<Node<'arena>>, dom: &'arena Node<'arena>) {
  let node = crate::oxvg::OxvgNode { node: dom, arena };
  let jobs = oxvg_optimiser::Jobs::<crate::oxvg::OxvgNode> {
    // Removing ids could break SVG sprites.
    cleanup_ids: None,
    ..Default::default()
  };
  match jobs.run(&node, &oxvg_ast::visitor::Info::default()) {
    Err(_err) => {}
    Ok(()) => {}
  }

  dom.walk(&mut |node| match &node.data {
    NodeData::Element { name, .. } => {
      if !matches!(
        name.local,
        local_name!("text")
          | local_name!("textPath")
          | local_name!("tspan")
          | local_name!("script")
          | local_name!("style")
      ) {
        remove_whitespace(node, &Default::default());
      }
    }
    _ => {}
  });
}

fn trim<'arena>(node: Ref<'arena>, attr: ExpandedName, options: &OptimizeOptions) {
  if !options.collapse_attribute_whitespace {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    let trimmed = value.trim();
    if trimmed.is_empty() && options.remove_empty_attributes {
      node.remove_attribute(attr);
    } else if trimmed.len() != value.len() {
      node.set_attribute(attr, trimmed);
    }
  }
}

fn trim_with_default<'arena>(
  node: Ref<'arena>,
  attr: ExpandedName,
  default: &str,
  options: &OptimizeOptions,
) {
  if !options.collapse_attribute_whitespace {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    let trimmed = value.trim();
    if (trimmed.is_empty() && options.remove_empty_attributes)
      || (trimmed == default && options.remove_redundant_attributes)
    {
      node.remove_attribute(attr);
    } else if trimmed.len() != value.len() {
      node.set_attribute(attr, trimmed);
    }
  }
}

// https://html.spec.whatwg.org/#space-separated-tokens
fn space_separated<'arena>(node: Ref<'arena>, attr: ExpandedName, options: &OptimizeOptions) {
  if !options.collapse_attribute_whitespace {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    let result = serialize_space_separated(value.split_whitespace(), value.len());
    if result.is_empty() && options.remove_empty_attributes {
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

fn unordered_space_separated_set<'arena>(
  node: Ref<'arena>,
  attr: ExpandedName,
  options: &OptimizeOptions,
) {
  if !options.collapse_attribute_whitespace {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    let mut items = value.split_whitespace().collect::<Vec<_>>();
    if options.sort_attributes_with_lists {
      items.sort();
      if options.deduplicate_attribute_values {
        items.dedup();
      }
    }
    if items.is_empty() && options.remove_empty_attributes {
      node.remove_attribute(attr);
      return;
    }

    let result = serialize_space_separated(items.into_iter(), value.len());
    node.set_attribute(attr, &result);
  }
}

fn ordered_space_separated_set<'arena>(
  node: Ref<'arena>,
  attr: ExpandedName,
  options: &OptimizeOptions,
) {
  if !options.collapse_attribute_whitespace {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    let mut items = value.split_whitespace().collect::<Vec<_>>();
    if options.deduplicate_attribute_values {
      let mut seen = HashSet::new();
      items.retain(|item| seen.insert(*item));
    }

    if items.is_empty() && options.remove_empty_attributes {
      node.remove_attribute(attr);
      return;
    }

    let result = serialize_space_separated(items.into_iter(), value.len());
    node.set_attribute(attr, &result);
  }
}

fn comma_separated<'arena>(node: Ref<'arena>, attr: ExpandedName, options: &OptimizeOptions) {
  if !options.collapse_attribute_whitespace {
    return;
  }

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
    if result.is_empty() && options.remove_empty_attributes {
      node.remove_attribute(attr);
    } else {
      node.set_attribute(attr, &result);
    }
  }
}

fn case_insensitive<'arena>(node: Ref<'arena>, attr: ExpandedName, options: &OptimizeOptions) {
  if !options.normalize_attribute_values {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    let lower = value.to_lowercase();
    if value.as_ref() != lower {
      node.set_attribute(attr, &lower);
    }
  }
}

fn enumerated<'arena>(
  node: Ref<'arena>,
  attr: ExpandedName,
  default: &str,
  options: &OptimizeOptions,
) {
  if let Some(value) = node.get_attribute(attr.clone()) {
    if value.eq_ignore_ascii_case(default) && options.remove_redundant_attributes {
      node.remove_attribute(attr);
      return;
    }

    if options.normalize_attribute_values {
      let lower = value.to_lowercase();
      if value.as_ref() != lower {
        node.set_attribute(attr, &lower);
      }
    }
  }
}

fn boolean<'arena>(node: Ref<'arena>, attr: ExpandedName, options: &OptimizeOptions) {
  if !options.collapse_boolean_attributes {
    return;
  }

  if let Some(value) = node.get_attribute(attr.clone()) {
    if value.eq_ignore_ascii_case(&attr.local) {
      node.set_attribute(attr, "");
    }
  }
}

fn remove_whitespace<'arena>(node: Ref<'arena>, options: &OptimizeOptions) {
  if !options.collapse_whitespace {
    return;
  }

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

    optimize(&arena, dom, Default::default());

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

  #[test]
  fn test_svg() {
    test(
      "<svg><style>.foo{fill:red}</style><rect width=100 height=100 class=foo /></svg>",
      "<svg><rect width=100 height=100 style=fill:red /></svg>",
    );
  }
}
