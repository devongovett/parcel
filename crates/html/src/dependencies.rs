use std::cell::RefCell;
use std::fmt::Write;
use std::hash::{DefaultHasher, Hash, Hasher};

use crate::arena::{Node, NodeData};
use crate::srcset::parse_srcset;
use crate::SerializableTendril;
use html5ever::tendril::{format_tendril, StrTendril};
use html5ever::{expanded_name, local_name, namespace_url, ns, Attribute, ExpandedName, QualName};
use serde::Serialize;
use typed_arena::Arena;

#[derive(Serialize, Hash)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
  pub href: SerializableTendril,
  pub needs_stable_name: bool,
  pub priority: Priority,
  pub output_format: OutputFormat,
  pub source_type: SourceType,
  pub bundle_behavior: BundleBehavior,
  pub placeholder: SerializableTendril,
  pub line: u64,
}

impl Dependency {
  fn set_placeholder(&mut self) -> &str {
    let mut hasher = DefaultHasher::new();
    self.href.hash(&mut hasher);
    self.needs_stable_name.hash(&mut hasher);
    self.priority.hash(&mut hasher);
    self.output_format.hash(&mut hasher);
    self.source_type.hash(&mut hasher);
    self.bundle_behavior.hash(&mut hasher);
    self.placeholder = SerializableTendril(format_tendril!("{:x}", hasher.finish()));
    self.placeholder.0.as_ref()
  }
}

#[derive(Serialize, Hash, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
  Sync,
  Parallel,
  Lazy,
}

#[derive(Serialize, Hash, PartialEq, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
  None,
  Global,
  Esmodule,
}

#[derive(PartialEq, Serialize, Hash, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum SourceType {
  None,
  Module,
  Script,
}

#[derive(PartialEq, Serialize, Hash, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum BundleBehavior {
  None,
  Isolated,
  Inline,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
  #[serde(rename = "type")]
  pub ty: SerializableTendril,
  #[serde(with = "serde_bytes")]
  pub content: Vec<u8>,
  pub key: SerializableTendril,
  pub is_attr: bool,
  pub output_format: OutputFormat,
  pub source_type: SourceType,
  pub line: u64,
}

#[derive(Serialize)]
pub struct Error {
  message: String,
  line: u64,
}

pub fn collect_dependencies<'arena>(
  arena: &'arena Arena<Node<'arena>>,
  dom: &'arena Node<'arena>,
  scope_hoist: bool,
  supports_esm: bool,
  hmr: bool,
) -> (Vec<Dependency>, Vec<Asset>, Vec<Error>) {
  let mut collector = DependencyCollector::new(arena, scope_hoist, supports_esm);

  dom.walk(&mut |node| {
    if let NodeData::Element { name, .. } = &node.data {
      collector.visit_element(node, name);
    }
  });

  if hmr && !collector.has_module_scripts {
    if let Some(body) = dom.find(expanded_name!(html "body")) {
      let key: StrTendril = "hmr.js".into();
      let src = collector.add_dep(key.clone(), false, Priority::Parallel, 0);
      collector.assets.push(Asset {
        ty: SerializableTendril("application/javascript".into()),
        content: Vec::new(),
        key: SerializableTendril(key),
        is_attr: false,
        output_format: OutputFormat::None,
        source_type: SourceType::None,
        line: 0,
      });

      let script = NodeData::Element {
        name: QualName::new(None, ns!(html), local_name!("script")),
        attrs: RefCell::new(vec![Attribute {
          name: QualName::new(None, ns!(), local_name!("src")),
          value: src,
        }]),
        template_contents: None,
        mathml_annotation_xml_integration_point: false,
      };

      body.append(arena.alloc(Node::new(script, 0)));
    }
  }

  (collector.deps, collector.assets, collector.errors)
}

struct DependencyCollector<'arena> {
  arena: &'arena Arena<Node<'arena>>,
  scope_hoist: bool,
  supports_esm: bool,
  deps: Vec<Dependency>,
  assets: Vec<Asset>,
  key: u32,
  has_module_scripts: bool,
  errors: Vec<Error>,
}

impl<'arena> DependencyCollector<'arena> {
  fn new(arena: &'arena Arena<Node<'arena>>, scope_hoist: bool, supports_esm: bool) -> Self {
    DependencyCollector {
      arena,
      scope_hoist,
      supports_esm,
      deps: Vec::new(),
      assets: Vec::new(),
      key: 0,
      has_module_scripts: false,
      errors: Vec::new(),
    }
  }

  fn visit_element(&mut self, node: &'arena Node<'arena>, name: &QualName) {
    match name.expanded() {
      expanded_name!(html "link") => {
        let href = node.get_attribute(expanded_name!("", "href"));

        if let Some(mut href) = href {
          // Check for empty string
          if href.is_empty() {
            self.errors.push(Error {
              message: "'href' should not be empty string".into(),
              line: node.line,
            });
            return;
          }

          let mut needs_stable_name = false;
          let mut priority = Priority::Lazy;
          if let Some(rel) = node.get_attribute(expanded_name!("", "rel")) {
            if rel.as_ref() == "canonical" || rel.as_ref() == "manifest" {
              needs_stable_name = true;
              if rel.as_ref() == "manifest" && !href.contains(':') {
                // A hack to allow manifest.json rather than manifest.webmanifest.
                // If a custom pipeline is used, it is responsible for running @parcel/transformer-webmanifest.
                href = format_tendril!("webmanifest:{}", href);
              }
            } else if rel.as_ref() == "stylesheet" {
              // Keep in the same bundle group as the HTML.
              priority = Priority::Parallel;
            } else if rel.as_ref() == "alternate" {
              if let Some(t) = node.get_attribute(expanded_name!("", "type")) {
                if t.as_ref() == "application/rss+xml" || t.as_ref() == "application/atom+xml" {
                  needs_stable_name = true;
                }
              }
            }
          }

          let mut dep = Dependency {
            href: SerializableTendril(href),
            needs_stable_name,
            priority,
            source_type: SourceType::None,
            output_format: OutputFormat::None,
            bundle_behavior: BundleBehavior::None,
            placeholder: Default::default(),
            line: node.line,
          };

          node.set_attribute(expanded_name!("", "href"), dep.set_placeholder());
          self.deps.push(dep);
        }

        let imagesrcset = ExpandedName {
          ns: &ns!(),
          local: &"imagesrcset".into(),
        };

        self.handle_srcset(node, imagesrcset, node.line);
      }
      expanded_name!(html "script") => {
        let src = node.get_attribute(expanded_name!("", "src"));
        let ty = node.get_attribute(expanded_name!("", "type"));
        let mut output_format = OutputFormat::Global;
        let source_type = match &ty {
          Some(t) if t.as_ref() == "module" => {
            self.has_module_scripts = true;
            SourceType::Module
          }
          _ => SourceType::Script,
        };

        if let Some(src) = src {
          // Check for empty string
          if src.is_empty() {
            self.errors.push(Error {
              message: "'src' should not be empty string".into(),
              line: node.line,
            });
            return;
          }

          if source_type == SourceType::Module && (self.scope_hoist || self.supports_esm) {
            output_format = OutputFormat::Esmodule;
          }

          if output_format != OutputFormat::Esmodule {
            if source_type == SourceType::Module {
              node.set_attribute(expanded_name!("", "defer"), "");
            }
            node.remove_attribute(expanded_name!("", "type"));
          }

          // If the script is async it can be executed in any order, so it cannot depend
          // on any sibling scripts for dependencies. Keep all dependencies together.
          // Also, don't share dependencies between classic scripts and nomodule scripts
          // because nomodule scripts won't run when modules are supported.
          let mut bundle_behavior = BundleBehavior::None;
          if source_type == SourceType::Script
            || node.get_attribute(expanded_name!("", "async")).is_some()
          {
            bundle_behavior = BundleBehavior::Isolated;
          }

          // If this is a <script type="module">, and not all of the browser targets support ESM natively,
          // add a copy of the script tag with a nomodule attribute.
          if output_format == OutputFormat::Esmodule && !self.supports_esm {
            let copy = self.arena.alloc(Node::new(node.data.clone(), node.line));
            copy.remove_attribute(expanded_name!("", "type"));
            copy.set_attribute(expanded_name!("", "nomodule"), "");
            copy.set_attribute(expanded_name!("", "defer"), "");

            let mut dep = Dependency {
              href: SerializableTendril(src.clone()),
              priority: Priority::Parallel,
              output_format: OutputFormat::Global,
              needs_stable_name: false,
              source_type,
              bundle_behavior,
              placeholder: Default::default(),
              line: node.line,
            };

            copy.set_attribute(expanded_name!("", "src"), dep.set_placeholder());
            self.deps.push(dep);
            node.insert_before(copy);
          }

          let mut dep = Dependency {
            href: SerializableTendril(src),
            priority: Priority::Parallel,
            output_format,
            needs_stable_name: false,
            source_type,
            bundle_behavior,
            placeholder: Default::default(),
            line: node.line,
          };

          node.set_attribute(expanded_name!("", "src"), dep.set_placeholder());
          self.deps.push(dep);
        } else {
          if let Some(ty) = &ty {
            if ty.as_ref() == "application/json"
              || ty.as_ref() == "text/html"
              || ty.as_ref() == "importmap"
            {
              return;
            }
          }

          let code = node.text_content();

          if source_type == SourceType::Module && self.scope_hoist && self.supports_esm {
            output_format = OutputFormat::Esmodule;
          } else {
            node.remove_attribute(expanded_name!("", "type"));
          }

          let data_parcel_key = ExpandedName {
            ns: &ns!(),
            local: &"data-parcel-key".into(),
          };

          let key = if let Some(key) = node.get_attribute(data_parcel_key.clone()) {
            key
          } else {
            let mut hash = DefaultHasher::new();
            code.hash(&mut hash);
            let key: StrTendril = format!("{:x}", hash.finish()).into();
            node.set_attribute(data_parcel_key, &key);
            key
          };

          self.assets.push(Asset {
            ty: SerializableTendril(ty.unwrap_or_else(|| "application/javascript".into())),
            content: code.into_bytes(),
            key: SerializableTendril(key.clone()),
            is_attr: false,
            source_type,
            output_format,
            line: node.line,
          });

          self.deps.push(Dependency {
            href: SerializableTendril(key.clone()),
            needs_stable_name: false,
            priority: Priority::Sync,
            output_format,
            source_type,
            bundle_behavior: BundleBehavior::Inline,
            placeholder: SerializableTendril(key),
            line: node.line,
          });
        }
      }
      expanded_name!(html "style") => {
        let code = node.text_content();
        let data_parcel_key = ExpandedName {
          ns: &ns!(),
          local: &"data-parcel-key".into(),
        };

        let key = if let Some(key) = node.get_attribute(data_parcel_key.clone()) {
          key
        } else {
          let mut hash = DefaultHasher::new();
          code.hash(&mut hash);
          let key: StrTendril = format!("{:x}", hash.finish()).into();
          node.set_attribute(data_parcel_key, &key);
          key
        };

        let ty = if let Some(ty) = node.get_attribute(expanded_name!("", "type")) {
          node.remove_attribute(expanded_name!("", "type"));
          ty
        } else {
          "text/css".into()
        };

        self.assets.push(Asset {
          ty: SerializableTendril(ty),
          content: code.into_bytes(),
          key: SerializableTendril(key.clone()),
          is_attr: false,
          output_format: OutputFormat::None,
          source_type: SourceType::None,
          line: node.line,
        });

        self.deps.push(Dependency {
          href: SerializableTendril(key.clone()),
          needs_stable_name: false,
          priority: Priority::Sync,
          output_format: OutputFormat::None,
          source_type: SourceType::None,
          bundle_behavior: BundleBehavior::Inline,
          placeholder: SerializableTendril(key),
          line: node.line,
        });
      }
      expanded_name!(html "meta") => {
        // A list of metadata that should produce a dependency
        // Based on:
        // - http://schema.org/
        // - http://ogp.me
        // - https://developer.twitter.com/en/docs/tweets/optimize-with-cards/overview/markup
        // - https://msdn.microsoft.com/en-us/library/dn255024.aspx
        // - https://vk.com/dev/publications
        let mut is_dep = false;
        let mut needs_stable_name = true;
        if let Some(property) = node.get_attribute(expanded_name!("", "property")) {
          is_dep = matches!(
            property.as_ref(),
            "og:image"
              | "og:image:url"
              | "og:image:secure_url"
              | "og:audio"
              | "og:audio:secure_url"
              | "og:video"
              | "og:video:secure_url"
              | "vk:image"
          );
        } else if let Some(name) = node.get_attribute(expanded_name!("", "name")) {
          if name.as_ref() == "twitter:image" {
            is_dep = true;
          } else if name.as_ref() == "msapplication-config" {
            if let Some(content) = node.get_attribute(expanded_name!("", "content")) {
              is_dep = content.as_ref() != "none";
            }
          } else {
            is_dep = matches!(
              name.as_ref(),
              "msapplication-square150x150logo"
                | "msapplication-square310x310logo"
                | "msapplication-square70x70logo"
                | "msapplication-wide310x150logo"
                | "msapplication-TileImage"
            );
            needs_stable_name = false;
          }
        } else if let Some(itemprop) = node.get_attribute(expanded_name!("", "itemprop")) {
          is_dep = matches!(
            itemprop.as_ref(),
            "image" | "logo" | "screenshot" | "thumbnailUrl" | "contentUrl" | "downloadUrl"
          );
        }

        if is_dep {
          let content = node.get_attribute(expanded_name!("", "content"));
          if let Some(content) = content {
            if !content.is_empty() {
              let placeholder = self.add_dep(content, needs_stable_name, Priority::Lazy, node.line);
              node.set_attribute(expanded_name!("", "content"), &placeholder);
            }
          }
        }
      }
      expanded_name!(html "img") | expanded_name!(html "source") => {
        self.handle_attr(node, expanded_name!("", "src"), false, node.line);
        self.handle_srcset(node, expanded_name!("", "srcset"), node.line);
      }
      expanded_name!(html "audio")
      | expanded_name!(html "track")
      | expanded_name!(html "embed") => {
        self.handle_attr(node, expanded_name!("", "src"), false, node.line);
      }
      expanded_name!(html "video") => {
        self.handle_attr(node, expanded_name!("", "src"), false, node.line);
        self.handle_attr(node, expanded_name!("", "poster"), false, node.line);
      }
      expanded_name!(html "iframe") => {
        self.handle_attr(node, expanded_name!("", "src"), true, node.line);
      }
      expanded_name!(html "object") => {
        self.handle_attr(node, expanded_name!("", "data"), false, node.line);
      }
      expanded_name!(html "a") => {
        if let Some(href) = node.get_attribute(expanded_name!("", "href")) {
          // Check for id references
          if href.is_empty() || href.starts_with('#') {
            return;
          }

          // Check for virtual paths
          let path = href.split_once('#').map_or(href.as_ref(), |p| p.0);
          if path.rfind('.').unwrap_or(0) < 1 {
            return;
          }

          let placeholder = self.add_dep(href, true, Priority::Lazy, node.line);
          node.set_attribute(expanded_name!("", "href"), &placeholder);
        }
      }
      expanded_name!(svg "use") | expanded_name!(svg "script") | expanded_name!(svg "image") => {
        self.handle_attr(node, expanded_name!("", "href"), false, node.line);
        self.handle_attr(node, expanded_name!(xlink "href"), false, node.line);
      }
      _ => {}
    }

    if let Some(style) = node.get_attribute(expanded_name!("", "style")) {
      let mut hash = DefaultHasher::new();
      style.hash(&mut hash);
      let key: StrTendril = format!("{:x}", hash.finish()).into();
      node.set_attribute(expanded_name!("", "style"), &key);

      self.deps.push(Dependency {
        href: SerializableTendril(key.clone()),
        needs_stable_name: false,
        priority: Priority::Sync,
        output_format: OutputFormat::None,
        source_type: SourceType::None,
        bundle_behavior: BundleBehavior::Inline,
        placeholder: SerializableTendril(key.clone()),
        line: node.line,
      });

      self.assets.push(Asset {
        ty: SerializableTendril("text/css".into()),
        content: style.to_string().into_bytes(),
        key: SerializableTendril(key),
        is_attr: true,
        output_format: OutputFormat::None,
        source_type: SourceType::None,
        line: node.line,
      });
    }
  }

  fn handle_attr(
    &mut self,
    node: &'arena Node<'arena>,
    name: ExpandedName,
    needs_stable_name: bool,
    line: u64,
  ) {
    let src = node.get_attribute(name.clone());
    if let Some(src) = src {
      // Check for empty string
      if src.is_empty() {
        self.errors.push(Error {
          message: format!("'{}' should not be empty string", name.local),
          line,
        });
        return;
      }

      // Check for id references
      if src.starts_with('#') {
        return;
      }

      let placeholder = self.add_dep(src, needs_stable_name, Priority::Lazy, line);
      node.set_attribute(name, &placeholder);
    }
  }

  fn handle_srcset(&mut self, node: &'arena Node<'arena>, name: ExpandedName, line: u64) {
    let srcset = node.get_attribute(name.clone());
    if let Some(srcset) = srcset {
      let mut res = String::with_capacity(srcset.len());
      let mut srcset = parse_srcset(srcset.as_ref());
      for img in &mut srcset {
        let mut hasher = DefaultHasher::new();
        img.url.hash(&mut hasher);
        let placeholder = format_tendril!("{:x}", hasher.finish());

        self.deps.push(Dependency {
          href: SerializableTendril(img.url.clone().into()),
          priority: Priority::Lazy,
          output_format: OutputFormat::None,
          needs_stable_name: false,
          source_type: SourceType::None,
          bundle_behavior: BundleBehavior::None,
          placeholder: SerializableTendril(placeholder.clone()),
          line,
        });

        img.url = placeholder.into();

        if !res.is_empty() {
          res.push_str(", ");
        }
        write!(&mut res, "{}", img);
      }

      node.set_attribute(name, &res);
    }
  }

  fn add_dep(
    &mut self,
    src: StrTendril,
    needs_stable_name: bool,
    priority: Priority,
    line: u64,
  ) -> StrTendril {
    let mut dep = Dependency {
      href: SerializableTendril(src),
      priority,
      output_format: OutputFormat::None,
      needs_stable_name,
      source_type: SourceType::None,
      bundle_behavior: BundleBehavior::None,
      placeholder: Default::default(),
      line,
    };

    let placeholder = dep.set_placeholder().into();
    self.deps.push(dep);
    placeholder
  }
}
