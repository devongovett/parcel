// Copyright 2014-2017 The html5ever Project Developers. See the
// COPYRIGHT file at the top-level directory of this distribution.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use html5ever::interface::tree_builder::{ElementFlags, NodeOrText, QuirksMode, TreeSink};
use html5ever::serialize::{Serialize, Serializer, TraversalScope};
use html5ever::tendril::StrTendril;
use html5ever::{Attribute, ExpandedName, QualName};
use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::collections::{HashSet, VecDeque};
use std::io;
use std::ptr;

type Arena<'arena> = &'arena typed_arena::Arena<Node<'arena>>;
type Ref<'arena> = &'arena Node<'arena>;
type Link<'arena> = Cell<Option<Ref<'arena>>>;

/// Sink struct is responsible for handling how the data that comes out of the HTML parsing
/// unit (TreeBuilder in our case) is handled.
pub struct Sink<'arena> {
  arena: Arena<'arena>,
  document: Ref<'arena>,
  quirks_mode: Cell<QuirksMode>,
  line: Cell<u64>,
}

impl<'arena> Sink<'arena> {
  pub fn new(arena: Arena<'arena>) -> Self {
    Sink {
      arena,
      document: arena.alloc(Node::new(NodeData::Document, 1)),
      quirks_mode: Cell::new(QuirksMode::NoQuirks),
      line: Cell::new(1),
    }
  }
}

/// DOM node which contains links to other nodes in the tree.
pub struct Node<'arena> {
  parent: Link<'arena>,
  next_sibling: Link<'arena>,
  previous_sibling: Link<'arena>,
  first_child: Link<'arena>,
  last_child: Link<'arena>,
  pub data: NodeData<'arena>,
  pub line: u64,
}

/// HTML node data which can be an element, a comment, a string, a DOCTYPE, etc...
#[derive(Clone)]
pub enum NodeData<'arena> {
  Document,
  Doctype {
    name: StrTendril,
    public_id: StrTendril,
    system_id: StrTendril,
  },
  Text {
    contents: RefCell<StrTendril>,
  },
  Comment {
    contents: StrTendril,
  },
  Element {
    name: QualName,
    attrs: RefCell<Vec<Attribute>>,
    template_contents: Option<Ref<'arena>>,
    mathml_annotation_xml_integration_point: bool,
  },
  ProcessingInstruction {
    target: StrTendril,
    contents: StrTendril,
  },
}

impl<'arena> Node<'arena> {
  pub fn new(data: NodeData<'arena>, line: u64) -> Self {
    Node {
      parent: Cell::new(None),
      previous_sibling: Cell::new(None),
      next_sibling: Cell::new(None),
      first_child: Cell::new(None),
      last_child: Cell::new(None),
      data,
      line,
    }
  }

  pub fn create_element(name: ExpandedName) -> Self {
    Node::new(
      NodeData::Element {
        name: QualName::new(None, name.ns.clone(), name.local.clone()),
        attrs: RefCell::new(Vec::new()),
        template_contents: None,
        mathml_annotation_xml_integration_point: false,
      },
      1,
    )
  }

  pub fn detach(&self) {
    let parent = self.parent.take();
    let previous_sibling = self.previous_sibling.take();
    let next_sibling = self.next_sibling.take();

    if let Some(next_sibling) = next_sibling {
      next_sibling.previous_sibling.set(previous_sibling);
    } else if let Some(parent) = parent {
      parent.last_child.set(previous_sibling);
    }

    if let Some(previous_sibling) = previous_sibling {
      previous_sibling.next_sibling.set(next_sibling);
    } else if let Some(parent) = parent {
      parent.first_child.set(next_sibling);
    }
  }

  pub fn append(&'arena self, new_child: &'arena Self) {
    new_child.detach();
    new_child.parent.set(Some(self));
    if let Some(last_child) = self.last_child.take() {
      new_child.previous_sibling.set(Some(last_child));
      debug_assert!(last_child.next_sibling.get().is_none());
      last_child.next_sibling.set(Some(new_child));
    } else {
      debug_assert!(self.first_child.get().is_none());
      self.first_child.set(Some(new_child));
    }
    self.last_child.set(Some(new_child));
  }

  pub fn prepend(&'arena self, new_child: &'arena Self) {
    new_child.detach();
    new_child.parent.set(Some(self));
    if let Some(first_child) = self.first_child.take() {
      new_child.next_sibling.set(Some(first_child));
      debug_assert!(first_child.previous_sibling.get().is_none());
      first_child.previous_sibling.set(Some(new_child));
    } else {
      debug_assert!(self.last_child.get().is_none());
      self.last_child.set(Some(new_child));
    }
    self.first_child.set(Some(new_child));
  }

  pub fn insert_before(&'arena self, new_sibling: &'arena Self) {
    new_sibling.detach();
    new_sibling.parent.set(self.parent.get());
    new_sibling.next_sibling.set(Some(self));
    if let Some(previous_sibling) = self.previous_sibling.take() {
      new_sibling.previous_sibling.set(Some(previous_sibling));
      debug_assert!(ptr::eq::<Node>(
        previous_sibling.next_sibling.get().unwrap(),
        self
      ));
      previous_sibling.next_sibling.set(Some(new_sibling));
    } else if let Some(parent) = self.parent.get() {
      debug_assert!(ptr::eq::<Node>(parent.first_child.get().unwrap(), self));
      parent.first_child.set(Some(new_sibling));
    }
    self.previous_sibling.set(Some(new_sibling));
  }

  pub fn walk<Visit: FnMut(Ref<'arena>)>(&'arena self, visit: &mut Visit) {
    visit(self);
    let mut node = self.first_child.get();
    while let Some(n) = node {
      node = n.next_sibling.get();
      n.walk(visit);
    }
  }

  pub fn text_content(&'arena self) -> String {
    let mut code = String::new();
    let mut child: Option<&Node<'arena>> = self.first_child.get();
    while let Some(c) = child {
      match &c.data {
        NodeData::Text { contents } => {
          code += contents.borrow().as_ref();
        }
        _ => {}
      }
      child = c.next_sibling.get();
    }
    code
  }

  pub fn set_text_content(&'arena self, arena: Arena<'arena>, content: StrTendril) {
    let text = arena.alloc(Node::new(
      NodeData::Text {
        contents: RefCell::new(content),
      },
      0,
    ));
    self.first_child.set(Some(text));
    self.last_child.set(Some(text));
  }

  pub fn find(&'arena self, element: ExpandedName) -> Option<Ref<'arena>> {
    if let NodeData::Element { name, .. } = &self.data {
      if name.expanded() == element {
        return Some(self);
      }
    }

    let mut node = self.first_child.get();
    while let Some(n) = node {
      if let Some(found) = n.find(element) {
        return Some(found);
      }
      node = n.next_sibling.get();
    }
    None
  }

  pub fn get_attribute(&'arena self, name: ExpandedName) -> Option<StrTendril> {
    if let NodeData::Element { attrs, .. } = &self.data {
      attrs.borrow().iter().find_map(|a| {
        if a.name.expanded() == name {
          Some(a.value.clone())
        } else {
          None
        }
      })
    } else {
      None
    }
  }

  pub fn set_attribute(&'arena self, name: ExpandedName, value: &str) {
    if let NodeData::Element { attrs, .. } = &self.data {
      let mut attrs = attrs.borrow_mut();
      if let Some(attr) = attrs.iter_mut().find(|a| a.name.expanded() == name) {
        attr.value = value.into();
      } else {
        attrs.push(Attribute {
          name: QualName::new(None, name.ns.clone(), name.local.clone()),
          value: value.into(),
        })
      }
    }
  }

  pub fn remove_attribute(&'arena self, name: ExpandedName) {
    if let NodeData::Element { attrs, .. } = &self.data {
      let mut attrs = attrs.borrow_mut();
      if let Some(idx) = attrs.iter().position(|a| a.name.expanded() == name) {
        attrs.remove(idx);
      }
    }
  }
}

impl<'arena> Sink<'arena> {
  fn new_node(&self, data: NodeData<'arena>) -> Ref<'arena> {
    self.arena.alloc(Node::new(data, self.line.get()))
  }

  fn append_common<P, A>(&self, child: NodeOrText<Ref<'arena>>, previous: P, append: A)
  where
    P: FnOnce() -> Option<Ref<'arena>>,
    A: FnOnce(Ref<'arena>),
  {
    let new_node = match child {
      NodeOrText::AppendText(text) => {
        // Append to an existing Text node if we have one.
        if let Some(&Node {
          data: NodeData::Text { ref contents },
          ..
        }) = previous()
        {
          contents.borrow_mut().push_tendril(&text);
          return;
        }
        self.new_node(NodeData::Text {
          contents: RefCell::new(text),
        })
      }
      NodeOrText::AppendNode(node) => node,
    };

    append(new_node)
  }
}

/// By implementing the TreeSink trait we determine how the data from the tree building step
/// is processed. In our case, our data is allocated in the arena and added to the Node data
/// structure.
///
/// For deeper understating of each function go to the TreeSink declaration.
impl<'arena> TreeSink for Sink<'arena> {
  type Handle = Ref<'arena>;
  type Output = Ref<'arena>;
  type ElemName<'a>
    = &'a QualName
  where
    Self: 'a;

  fn finish(self) -> Ref<'arena> {
    self.document
  }

  fn parse_error(&self, _: Cow<'static, str>) {}

  fn get_document(&self) -> Ref<'arena> {
    self.document
  }

  fn set_quirks_mode(&self, mode: QuirksMode) {
    self.quirks_mode.set(mode);
  }

  fn set_current_line(&self, line: u64) {
    self.line.set(line);
  }

  fn same_node(&self, x: &Ref<'arena>, y: &Ref<'arena>) -> bool {
    ptr::eq::<Node>(*x, *y)
  }

  fn elem_name(&self, target: &Ref<'arena>) -> Self::ElemName<'_> {
    match target.data {
      NodeData::Element { ref name, .. } => name,
      _ => panic!("not an element!"),
    }
  }

  fn get_template_contents(&self, target: &Ref<'arena>) -> Ref<'arena> {
    if let NodeData::Element {
      template_contents: Some(contents),
      ..
    } = target.data
    {
      contents
    } else {
      panic!("not a template element!")
    }
  }

  fn is_mathml_annotation_xml_integration_point(&self, target: &Ref<'arena>) -> bool {
    if let NodeData::Element {
      mathml_annotation_xml_integration_point,
      ..
    } = target.data
    {
      mathml_annotation_xml_integration_point
    } else {
      panic!("not an element!")
    }
  }

  fn create_element(
    &self,
    name: QualName,
    attrs: Vec<Attribute>,
    flags: ElementFlags,
  ) -> Ref<'arena> {
    self.new_node(NodeData::Element {
      name,
      attrs: RefCell::new(attrs),
      template_contents: if flags.template {
        Some(self.new_node(NodeData::Document))
      } else {
        None
      },
      mathml_annotation_xml_integration_point: flags.mathml_annotation_xml_integration_point,
    })
  }

  fn create_comment(&self, text: StrTendril) -> Ref<'arena> {
    self.new_node(NodeData::Comment { contents: text })
  }

  fn create_pi(&self, target: StrTendril, data: StrTendril) -> Ref<'arena> {
    self.new_node(NodeData::ProcessingInstruction {
      target,
      contents: data,
    })
  }

  fn append(&self, parent: &Ref<'arena>, child: NodeOrText<Ref<'arena>>) {
    self.append_common(
      child,
      || parent.last_child.get(),
      |new_node| parent.append(new_node),
    )
  }

  fn append_before_sibling(&self, sibling: &Ref<'arena>, child: NodeOrText<Ref<'arena>>) {
    self.append_common(
      child,
      || sibling.previous_sibling.get(),
      |new_node| sibling.insert_before(new_node),
    )
  }

  fn append_based_on_parent_node(
    &self,
    element: &Ref<'arena>,
    prev_element: &Ref<'arena>,
    child: NodeOrText<Ref<'arena>>,
  ) {
    if element.parent.get().is_some() {
      self.append_before_sibling(element, child)
    } else {
      self.append(prev_element, child)
    }
  }

  fn append_doctype_to_document(
    &self,
    name: StrTendril,
    public_id: StrTendril,
    system_id: StrTendril,
  ) {
    self.document.append(self.new_node(NodeData::Doctype {
      name,
      public_id,
      system_id,
    }))
  }

  fn add_attrs_if_missing(&self, target: &Ref<'arena>, attrs: Vec<Attribute>) {
    let mut existing = if let NodeData::Element { ref attrs, .. } = target.data {
      attrs.borrow_mut()
    } else {
      panic!("not an element")
    };

    let existing_names = existing
      .iter()
      .map(|e| e.name.clone())
      .collect::<HashSet<_>>();
    existing.extend(
      attrs
        .into_iter()
        .filter(|attr| !existing_names.contains(&attr.name)),
    );
  }

  fn remove_from_parent(&self, target: &Ref<'arena>) {
    target.detach()
  }

  fn reparent_children(&self, node: &Ref<'arena>, new_parent: &Ref<'arena>) {
    let mut next_child = node.first_child.get();
    while let Some(child) = next_child {
      debug_assert!(ptr::eq::<Node>(child.parent.get().unwrap(), *node));
      next_child = child.next_sibling.get();
      new_parent.append(child)
    }
  }
}

enum SerializeOp<'arena> {
  Open(Ref<'arena>),
  Close(QualName),
}

pub struct SerializableHandle<'arena>(Ref<'arena>);

impl<'arena> From<Ref<'arena>> for SerializableHandle<'arena> {
  fn from(h: Ref<'arena>) -> SerializableHandle<'arena> {
    SerializableHandle(h)
  }
}

impl<'arena> Serialize for SerializableHandle<'arena> {
  fn serialize<S>(&self, serializer: &mut S, traversal_scope: TraversalScope) -> io::Result<()>
  where
    S: Serializer,
  {
    use TraversalScope::*;
    let mut ops = VecDeque::new();
    match traversal_scope {
      IncludeNode => ops.push_back(SerializeOp::Open(self.0)),
      ChildrenOnly(_) => {
        let mut child = self.0.first_child.get();
        while let Some(c) = child {
          ops.push_back(SerializeOp::Open(c));
          child = c.next_sibling.get();
        }
      }
    }

    while let Some(op) = ops.pop_front() {
      match op {
        SerializeOp::Open(handle) => match handle.data {
          NodeData::Element {
            ref name,
            ref attrs,
            ..
          } => {
            serializer.start_elem(
              name.clone(),
              attrs.borrow().iter().map(|at| (&at.name, &at.value[..])),
            )?;

            // ops.reserve(1 + handle.children.borrow().len());
            ops.push_front(SerializeOp::Close(name.clone()));

            let mut child = handle.last_child.get();
            while let Some(c) = child {
              ops.push_front(SerializeOp::Open(c));
              child = c.previous_sibling.get();
            }
          }

          NodeData::Doctype { ref name, .. } => serializer.write_doctype(name)?,

          NodeData::Text { ref contents } => serializer.write_text(&contents.borrow())?,

          NodeData::Comment { ref contents } => serializer.write_comment(contents)?,

          NodeData::ProcessingInstruction {
            ref target,
            ref contents,
          } => serializer.write_processing_instruction(target, contents)?,

          NodeData::Document => panic!("Can't serialize Document node itself"),
        },

        SerializeOp::Close(name) => {
          serializer.end_elem(name)?;
        }
      }
    }

    Ok(())
  }
}
