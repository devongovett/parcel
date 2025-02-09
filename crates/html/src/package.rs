use std::collections::HashMap;

use crate::{
  arena::{Node, NodeData},
  SerializableTendril,
};
use html5ever::{expanded_name, local_name, namespace_url, ns, ExpandedName};
use serde::Deserialize;
use typed_arena::Arena;

#[derive(Deserialize)]
#[serde(tag = "type", content = "value")]
pub enum BundleReference {
  StyleSheet {
    href: SerializableTendril,
  },
  Script {
    src: SerializableTendril,
    module: bool,
    nomodule: bool,
  },
}

#[derive(Deserialize)]
pub struct InlineBundle {
  contents: SerializableTendril,
  module: bool,
}

pub fn insert_bundle_references<'arena>(
  arena: &'arena Arena<Node<'arena>>,
  dom: &'arena Node<'arena>,
  bundles: Vec<BundleReference>,
  inline_bundles: HashMap<SerializableTendril, InlineBundle>,
  mut import_map: serde_json::map::Map<String, serde_json::Value>,
) {
  let data_parcel_key = ExpandedName {
    ns: &ns!(),
    local: &"data-parcel-key".into(),
  };

  let mut import_map_node = None;

  dom.walk(&mut |node| {
    if let NodeData::Element { name, attrs, .. } = &node.data {
      match name.expanded() {
        expanded_name!(html "script") | expanded_name!(svg "script") => {
          if let Some(key) = node.get_attribute(data_parcel_key.clone()) {
            if let Some(bundle) = inline_bundles.get(&SerializableTendril(key)) {
              node.remove_attribute(data_parcel_key.clone());
              node.set_text_content(arena, bundle.contents.0.clone());
              if bundle.module {
                node.set_attribute(expanded_name!("", "type"), "module");
              }
            }
          } else if let Some(t) = node.get_attribute(expanded_name!("", "type")) {
            if t.as_ref() == "importmap" {
              import_map_node = Some(node);
            }
          }
        }
        expanded_name!(html "style") | expanded_name!(svg "style") => {
          if let Some(key) = node.get_attribute(data_parcel_key.clone()) {
            if let Some(bundle) = inline_bundles.get(&SerializableTendril(key)) {
              node.remove_attribute(data_parcel_key.clone());
              node.set_text_content(arena, bundle.contents.0.clone());
            }
          }
        }
        _ => {}
      }

      for attr in attrs.borrow_mut().iter_mut() {
        if let Some(bundle) = inline_bundles.get(&SerializableTendril(attr.value.clone())) {
          attr.value = bundle.contents.0.clone();
        }
      }
    }
  });

  if let Some(head) = dom.find(expanded_name!(html "head")) {
    for bundle in bundles.into_iter().rev() {
      match bundle {
        BundleReference::StyleSheet { href } => {
          let node = arena.alloc(Node::create_element(expanded_name!(html "link")));
          node.set_attribute(expanded_name!("", "rel"), "stylesheet");
          node.set_attribute(expanded_name!("", "href"), &href.0);
          head.prepend(node);
        }
        BundleReference::Script {
          src,
          module,
          nomodule,
        } => {
          let node = arena.alloc(Node::create_element(expanded_name!(html "script")));
          if module {
            node.set_attribute(expanded_name!("", "type"), "module");
          }
          if nomodule {
            node.set_attribute(expanded_name!("", "nomodule"), "");
            node.set_attribute(expanded_name!("", "defer"), "");
          }
          node.set_attribute(expanded_name!("", "src"), &src.0);
          head.prepend(node);
        }
      }
    }

    if !import_map.is_empty() {
      // If there is an existing <script type="importmap">, merge with that.
      // This will remove the existing node so it is moved before all other scripts.
      if let Some(import_map_node) = import_map_node {
        let content: Result<serde_json::Value, _> =
          serde_json::from_str(&import_map_node.text_content());
        if let Ok(serde_json::Value::Object(mut obj)) = content {
          if let Some(serde_json::Value::Object(imports)) = obj.get_mut("imports") {
            imports.append(&mut import_map);
            if let Ok(json) = serde_json::to_string(&obj) {
              import_map_node.set_text_content(arena, json.into());
            }
          }
        }
        head.prepend(import_map_node);
      } else {
        let node = arena.alloc(Node::create_element(expanded_name!(html "script")));
        node.set_attribute(expanded_name!("", "type"), "importmap");
        let mut map = serde_json::Map::new();
        map.insert("imports".into(), serde_json::Value::Object(import_map));
        if let Ok(json) = serde_json::to_string(&map) {
          node.set_text_content(arena, json.into());
        }
        head.prepend(node);
      }
    }
  }
}
