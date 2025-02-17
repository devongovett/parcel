use std::{
  cell::{Cell, RefCell},
  collections::VecDeque,
  fmt::Debug,
  hash::{DefaultHasher, Hash, Hasher},
  ops::Deref,
};

use crate::arena::{NodeData, Ref};
use xml5ever::{local_name, tendril::StrTendril, Attribute, Namespace, QualName};

use oxvg_ast::{
  attribute::{Attr, Attributes},
  class_list::ClassList,
  document::Document,
  element::Element,
  implementations::markup5ever::{Attributes5Ever, ClassList5Ever},
  name::Name,
  node::{self, Node},
};

use oxvg_ast::serialize;

pub struct OxvgNode<'arena> {
  pub arena: crate::arena::Arena<'arena>,
  pub node: Ref<'arena>,
}

impl Clone for OxvgNode<'_> {
  fn clone(&self) -> Self {
    OxvgNode {
      arena: self.arena,
      node: self.node,
    }
  }
}

impl Debug for OxvgNode<'_> {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    self.node.fmt(f)
  }
}

impl PartialEq for OxvgNode<'_> {
  fn eq(&self, other: &Self) -> bool {
    self.node.eq(other.node)
  }
}

impl Eq for OxvgNode<'_> {}

impl Hash for OxvgNode<'_> {
  fn hash<H: Hasher>(&self, state: &mut H) {
    self.as_ptr_byte().hash(state)
  }
}

impl<'arena> Node for OxvgNode<'arena> {
  type Atom = StrTendril;
  type Child = OxvgNode<'arena>;
  type ParentChild = OxvgNode<'arena>;
  type Parent = OxvgNode<'arena>;

  fn ptr_eq(&self, other: &impl Node) -> bool {
    self.as_ptr_byte() == other.as_ptr_byte()
  }

  fn as_ptr_byte(&self) -> usize {
    self.node as *const crate::arena::Node as usize
  }

  // fn as_ref(&self) -> Box<dyn node::Ref> {
  //   Box::new(Node5EverRef(Rc::new(self.clone())))
  // }

  fn child_nodes_iter(&self) -> impl DoubleEndedIterator<Item = Self> {
    struct ChildIter<'arena> {
      arena: crate::arena::Arena<'arena>,
      cur: Option<Ref<'arena>>,
    }

    impl<'arena> Iterator for ChildIter<'arena> {
      type Item = OxvgNode<'arena>;

      fn next(&mut self) -> Option<Self::Item> {
        if let Some(c) = self.cur {
          self.cur = c.next_sibling.get();
          Some(OxvgNode {
            node: c,
            arena: self.arena,
          })
        } else {
          None
        }
      }
    }

    impl<'arena> DoubleEndedIterator for ChildIter<'arena> {
      fn next_back(&mut self) -> Option<Self::Item> {
        if let Some(c) = self.cur {
          self.cur = c.previous_sibling.get();
          Some(OxvgNode {
            node: c,
            arena: self.arena,
          })
        } else {
          None
        }
      }
    }

    ChildIter {
      cur: self.node.first_child.get(),
      arena: self.arena,
    }
  }

  fn has_child_nodes(&self) -> bool {
    self.node.first_child.get().is_some()
  }

  fn first_child(&self) -> Option<impl Node> {
    self.node.first_child.get().map(|node| OxvgNode {
      arena: self.arena,
      node,
    })
  }

  fn last_child(&self) -> Option<impl Node> {
    self.node.last_child.get().map(|node| OxvgNode {
      arena: self.arena,
      node,
    })
  }

  fn next_sibling(&self) -> Option<Self::ParentChild> {
    self.node.next_sibling.get().map(|node| OxvgNode {
      arena: self.arena,
      node,
    })
  }

  fn child_nodes(&self) -> Vec<Self::Child> {
    let mut children = Vec::new();
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      children.push(OxvgNode {
        node: c,
        arena: self.arena,
      });
      child = c.next_sibling.get();
    }
    children
  }

  fn child_node_count(&self) -> usize {
    let mut count = 0;
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      count += 1;
      child = c.next_sibling.get();
    }
    count
  }

  #[allow(refining_impl_trait)]
  fn element(&self) -> Option<OxvgNode<'arena>> {
    match self.node_type() {
      node::Type::Element => <OxvgNode as Element>::new(Node::to_owned(self)),
      _ => None,
    }
  }

  fn empty(&self) {
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      child = c.next_sibling.get();
      c.detach();
    }
  }

  #[allow(refining_impl_trait)]
  fn find_element(&self) -> Option<OxvgNode<'arena>> {
    <OxvgNode as Element>::find_element(Node::to_owned(self))
  }

  fn for_each_child<F>(&self, mut f: F)
  where
    F: FnMut(Self),
  {
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      f(OxvgNode {
        node: c,
        arena: self.arena,
      });
      child = c.next_sibling.get();
    }
  }

  fn try_for_each_child<F, E>(&self, mut f: F) -> Result<(), E>
  where
    F: FnMut(Self) -> Result<(), E>,
  {
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      f(OxvgNode {
        node: c,
        arena: self.arena,
      })?;
      child = c.next_sibling.get();
    }
    Ok(())
  }

  fn any_child<F>(&self, mut f: F) -> bool
  where
    F: FnMut(Self) -> bool,
  {
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      if f(OxvgNode {
        node: c,
        arena: self.arena,
      }) {
        return true;
      }
      child = c.next_sibling.get();
    }
    false
  }

  fn all_children<F>(&self, mut f: F) -> bool
  where
    F: FnMut(Self) -> bool,
  {
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      if !f(OxvgNode {
        node: c,
        arena: self.arena,
      }) {
        return false;
      }
      child = c.next_sibling.get();
    }
    true
  }

  fn retain_children<F>(&self, mut f: F)
  where
    F: FnMut(Self::Child) -> bool,
  {
    let mut child = self.node.first_child.get();
    while let Some(c) = child {
      child = c.next_sibling.get();
      if !f(OxvgNode {
        node: c,
        arena: self.arena,
      }) {
        c.detach();
      }
    }
  }

  fn node_type(&self) -> node::Type {
    match &self.node.data {
      NodeData::Comment { .. } => node::Type::Comment,
      NodeData::Doctype { .. } => node::Type::DocumentType,
      NodeData::Document => node::Type::Document,
      NodeData::Element { .. } => node::Type::Element,
      NodeData::ProcessingInstruction { .. } => node::Type::ProcessingInstruction,
      NodeData::Text { .. } => node::Type::Text,
    }
  }

  #[allow(refining_impl_trait)]
  fn parent_node(&self) -> Option<OxvgNode<'arena>> {
    self.node.parent.get().map(|parent| OxvgNode {
      node: parent,
      arena: self.arena,
    })
  }

  #[allow(refining_impl_trait)]
  fn set_parent_node(&self, new_parent: &Self::Parent) -> Option<OxvgNode<'arena>> {
    let parent = self.node.parent.get();
    self.node.detach();
    self.node.parent.set(Some(new_parent.node));
    parent.map(|parent| OxvgNode {
      node: parent,
      arena: self.arena,
    })
  }

  fn append_child(&mut self, a_child: Self::Child) {
    self.node.append(a_child.node);
  }

  fn insert_before(&mut self, new_node: Self::Child, reference_node: &Self::Child) {
    reference_node.node.insert_before(new_node.node);
  }

  fn insert_after(&mut self, new_node: Self::Child, reference_node: &Self::Child) {
    reference_node.node.insert_after(new_node.node);
  }

  fn insert(&mut self, index: usize, new_node: Self::Child) {
    let mut child = self.node.first_child.get();
    let mut i = 0;
    while let Some(c) = child {
      if i == index {
        c.insert_before(new_node.node);
        break;
      }
      i += 1;
      child = c.next_sibling.get();
    }
    if i == index {
      self.node.append(new_node.node);
    }
  }

  fn node_name(&self) -> Self::Atom {
    match &self.node.data {
      NodeData::Comment { .. } => "#comment".into(),
      NodeData::Doctype { name, .. } => name.clone(),
      NodeData::Document => "#document".into(),
      NodeData::Element { name, .. } => name.local.to_uppercase().into(),
      NodeData::ProcessingInstruction { target, .. } => target.clone(),
      NodeData::Text { .. } => "#text".into(),
    }
  }

  fn node_value(&self) -> Option<Self::Atom> {
    Some(match &self.node.data {
      NodeData::Comment { contents } => contents.clone(),
      NodeData::ProcessingInstruction { contents, .. } => contents.borrow().clone(),
      NodeData::Text { contents } => contents.borrow().clone(),
      _ => return None,
    })
  }

  fn processing_instruction(&self) -> Option<(Self::Atom, Self::Atom)> {
    match &self.node.data {
      NodeData::ProcessingInstruction { target, contents } => {
        Some((target.clone(), contents.borrow().clone()))
      }
      _ => None,
    }
  }

  fn try_set_node_value(&self, value: Self::Atom) -> Option<()> {
    match &self.node.data {
      NodeData::Text { contents } => {
        contents.replace(value);
        Some(())
      }
      _ => None,
    }
  }

  fn text_content(&self) -> Option<String> {
    match &self.node.data {
      NodeData::Doctype { .. } | NodeData::Document => None,
      // FIXME: Empty string should only be returned on recursive calls
      NodeData::Comment { contents } => Some(contents.to_string()),
      NodeData::ProcessingInstruction { contents, .. } => Some(contents.borrow().to_string()),
      NodeData::Text { contents } => Some(contents.borrow().to_string()),
      NodeData::Element { .. } => Some(self.node.text_content()),
    }
  }

  fn set_text_content(&mut self, content: Self::Atom) {
    match &self.node.data {
      NodeData::Text { contents } => *contents.borrow_mut() = content,
      NodeData::Element { .. } => {
        let text = self.text(content);
        self.empty();
        self.append_child(text);
      }
      _ => {}
    }
  }

  fn text(&self, content: Self::Atom) -> Self {
    OxvgNode {
      node: self.arena.alloc(crate::arena::Node::new(
        NodeData::Text {
          contents: RefCell::new(content),
        },
        0,
      )),
      arena: self.arena,
    }
  }

  fn remove(&self) {
    self.node.detach();
  }

  fn remove_child(&mut self, child: Self::Child) -> Option<Self::Child> {
    if child.node.parent.get() == Some(self.node) {
      child.node.detach();
      Some(child)
    } else {
      None
    }
  }

  fn remove_child_at(&mut self, index: usize) -> Option<Self::Child> {
    let mut child = self.node.first_child.get();
    let mut i = 0;
    while let Some(c) = child {
      if i == index {
        c.detach();
        return Some(OxvgNode {
          arena: self.arena,
          node: c,
        });
      }
      i += 1;
      child = c.next_sibling.get();
    }
    None
  }

  fn clone_node(&self) -> Self {
    OxvgNode {
      node: self
        .arena
        .alloc(crate::arena::Node::new(self.node.data.clone(), 0)),
      arena: self.arena,
    }
  }

  fn replace_child(
    &mut self,
    new_child: Self::Child,
    old_child: &Self::Child,
  ) -> Option<Self::Child> {
    let parent = old_child.node.parent.get();
    if let Some(parent) = parent {
      if parent != self.node {
        return None;
      }
    } else {
      return None;
    }
    let parent = old_child.node.parent.take();
    let previous_sibling = old_child.node.previous_sibling.take();
    let next_sibling = old_child.node.next_sibling.take();

    new_child.node.parent.set(parent);
    if previous_sibling.is_some() {
      new_child.node.previous_sibling.set(previous_sibling);
    } else {
      self.node.first_child.set(Some(new_child.node));
    }
    if next_sibling.is_some() {
      new_child.node.next_sibling.set(next_sibling);
    } else {
      self.node.last_child.set(Some(new_child.node));
    }
    Some(OxvgNode {
      arena: self.arena,
      node: old_child.node,
    })
  }

  fn to_owned(&self) -> Self {
    self.clone()
  }

  fn as_child(&self) -> Self::Child {
    self.clone()
  }

  fn as_impl(&self) -> impl Node {
    self.clone()
  }

  fn as_parent_child(&self) -> Self::ParentChild {
    Node::to_owned(self)
  }
}

impl<'arena> node::Features for OxvgNode<'arena> {}

impl<'arena> oxvg_ast::parse::Node for OxvgNode<'arena> {
  fn parse(_source: &str) -> anyhow::Result<Self> {
    todo!()
  }

  fn parse_file(mut _file: &std::fs::File) -> anyhow::Result<Self> {
    todo!()
  }

  fn parse_path(_path: &std::path::Path) -> anyhow::Result<Self> {
    todo!()
  }
}

impl<'arena> oxvg_ast::serialize::Node for OxvgNode<'arena> {
  fn serialize(&self) -> anyhow::Result<String> {
    todo!()
  }

  fn serialize_with_options(&self, _options: serialize::Options) -> anyhow::Result<String> {
    todo!()
  }

  fn serialize_into<Wr: std::io::Write>(&self, _sink: Wr) -> anyhow::Result<()> {
    todo!()
  }
}

impl<'arena> Element for OxvgNode<'arena> {
  type Name = QualName;
  type Attr = Attribute;
  type Attributes<'a> = Attributes5Ever<'a>;

  fn new(node: Self::Child) -> Option<Self> {
    if !matches!(node.node_type(), node::Type::Element | node::Type::Document) {
      return None;
    }
    Some(node)
  }

  fn as_document(&self) -> impl Document<Root = Self> {
    if matches!(self.node.data, NodeData::Document) {
      self.clone()
    } else {
      unreachable!()
    }
  }

  fn from_parent(node: Self::ParentChild) -> Option<Self> {
    Self::new(node)
  }

  fn attributes(&self) -> Self::Attributes<'_> {
    let attrs = if let NodeData::Element { attrs, .. } = &self.node.data {
      attrs
    } else {
      unreachable!()
    };
    Attributes5Ever(attrs)
  }

  fn set_attributes(&self, new_attrs: Self::Attributes<'_>) {
    let attrs = if let NodeData::Element { attrs, .. } = &self.node.data {
      attrs
    } else {
      unreachable!()
    };
    attrs.replace(new_attrs.0.take());
  }

  fn class_list(
    &self,
  ) -> impl ClassList<Attribute = <Self::Attributes<'_> as Attributes>::Attribute> {
    ClassList5Ever {
      attrs: self.attributes(),
      class_index_memo: Cell::new(0),
      tokens: self
        .attributes()
        .get_named_item_local(&local_name!("class"))
        .as_ref()
        .map(|a| a.value().split_whitespace().map(Into::into).collect())
        .unwrap_or_default(),
    }
  }

  fn has_class(&self, token: &Self::Atom) -> bool {
    let token = token.trim_start_matches('.');
    self.class_list().contains(&token.into())
  }

  fn document(&self) -> Option<Self> {
    let parent = self.parent_node()?;
    match parent.node.data {
      NodeData::Element { .. } => parent.document(),
      NodeData::Document => Some(parent),
      _ => None,
    }
  }

  fn for_each_element_child<F>(&self, mut f: F)
  where
    F: FnMut(Self),
  {
    #[allow(deprecated)]
    for child in self.child_nodes_iter() {
      if let NodeData::Element { .. } = &child.node.data {
        f(child)
      }
    }
  }

  fn sort_child_elements<F>(&self, mut f: F)
  where
    F: FnMut(Self, Self) -> std::cmp::Ordering,
  {
    let mut children = self.child_nodes();
    children.sort_by(|a, b| {
      let Some(a) = OxvgNode::new(a.clone()) else {
        return std::cmp::Ordering::Less;
      };
      let Some(b) = OxvgNode::new(b.clone()) else {
        return std::cmp::Ordering::Greater;
      };
      f(a.clone(), b.clone())
    });
    self.empty();
    for child in children {
      self.node.append(child.node);
    }
  }

  fn flatten(&self) {
    let parent = self.node.parent.take();
    let first_child = self.node.first_child.take();
    let last_child = self.node.last_child.take();

    if let Some(parent) = parent {
      if let Some(prev) = self.node.previous_sibling.take() {
        prev.next_sibling.set(first_child);
        if let Some(child) = first_child {
          child.previous_sibling.set(Some(prev));
        }
      } else {
        parent.first_child.set(first_child);
        if let Some(child) = first_child {
          child.previous_sibling.set(None);
        }
      }
      if let Some(next) = self.node.next_sibling.take() {
        next.previous_sibling.set(last_child);
        if let Some(child) = last_child {
          child.next_sibling.set(Some(next));
        }
      } else {
        parent.last_child.set(last_child);
        if let Some(child) = last_child {
          child.next_sibling.set(None);
        }
      }
    }

    let mut child = first_child;
    while let Some(c) = child {
      c.parent.set(parent);
      child = c.next_sibling.get();
    }
  }

  fn qual_name(&self) -> &Self::Name {
    if let NodeData::Element { name, .. } = &self.node.data {
      name
    } else {
      unreachable!()
    }
  }

  fn set_local_name(&mut self, local: <Self::Name as Name>::LocalName) {
    let mut data = self.node.data.clone();
    if let NodeData::Element { name, .. } = &mut data {
      name.local = local;
    }
    let node = self
      .arena
      .alloc(crate::arena::Node::new(data, self.node.line));
    let mut child = self.node.first_child.take();
    node.first_child.set(child);
    while let Some(c) = child {
      c.parent.set(Some(node));
      child = c.next_sibling.get();
    }
    node.last_child.set(self.node.last_child.take());
    self.replace_with(OxvgNode {
      node,
      arena: self.arena,
    });
  }

  fn append(&self, node: Self::Child) {
    self.node.append(node.node);
  }

  fn find_element(node: <Self as Node>::ParentChild) -> Option<Self> {
    let mut queue = VecDeque::new();
    queue.push_back(node.node);

    while let Some(current) = queue.pop_front() {
      if matches!(current.data, NodeData::Element { .. }) {
        return Some(OxvgNode {
          node: current,
          arena: node.arena,
        });
      }

      let mut child = current.first_child.get();
      while let Some(c) = child {
        queue.push_back(c);
        child = c.next_sibling.get();
      }
    }
    None
  }

  fn get_attribute<'a>(
    &'a self,
    name: &<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name,
  ) -> Option<Self::Atom> {
    self.get_attribute_node(name).map(|a| a.value.clone())
  }

  fn get_attribute_local<'a>(
    &'a self,
    name: &<<Self::Attr as Attr>::Name as Name>::LocalName,
  ) -> Option<Self::Atom> {
    self.get_attribute_node_local(name).map(|a| a.value.clone())
  }

  fn get_attribute_ns<'a>(
    &'a self,
    namespace: &<<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name as Name>::Namespace,
    name: &<<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name as Name>::LocalName,
  ) -> Option<Self::Atom> {
    self
      .get_attribute_node_ns(namespace, name)
      .map(|a| a.value.clone())
  }

  fn get_attribute_names(
    &self,
  ) -> Vec<<<Self::Attributes<'_> as Attributes<'_>>::Attribute as Attr>::Name> {
    let mut output = vec![];
    for attr in self.attributes().0.borrow().iter() {
      output.push(attr.name.clone());
    }
    output
  }

  fn get_attribute_node<'a>(
    &'a self,
    attr_name: &<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name,
  ) -> Option<impl Deref<Target = <Self::Attributes<'a> as Attributes<'a>>::Attribute>> {
    self.attributes().get_named_item(attr_name)
  }

  fn get_attribute_node_mut<'a>(
    &'a self,
    attr_name: &<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name,
  ) -> Option<impl std::ops::DerefMut<Target = <Self::Attributes<'a> as Attributes<'a>>::Attribute>>
  {
    self.attributes().get_named_item_mut(attr_name)
  }

  fn get_attribute_node_ns<'a>(
    &'a self,
    namespace: &<<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name as Name>::Namespace,
    name: &<<<Self::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name as Name>::LocalName,
  ) -> Option<impl Deref<Target = <Self::Attributes<'a> as Attributes<'a>>::Attribute>> {
    self.attributes().get_named_item_ns(namespace, name)
  }

  fn replace_children(&self, children: Vec<Self::Child>) {
    self.empty();
    for child in children {
      self.node.append(child.node);
    }
  }

  fn parent_element(&self) -> Option<Self> {
    let parent_node: OxvgNode<'arena> = self.parent_node()?;
    Self::new(parent_node)
  }

  fn next_element_sibling(&self) -> Option<Self> {
    let mut node = self.node.next_sibling.get();
    while let Some(n) = node {
      if matches!(n.data, NodeData::Element { .. }) {
        return Some(OxvgNode {
          arena: self.arena,
          node: n,
        });
      }
      node = n.next_sibling.get();
    }
    None
  }

  fn previous_element_sibling(&self) -> Option<Self> {
    let mut node = self.node.previous_sibling.get();
    while let Some(n) = node {
      if matches!(n.data, NodeData::Element { .. }) {
        return Some(OxvgNode {
          arena: self.arena,
          node: n,
        });
      }
      node = n.previous_sibling.get();
    }
    None
  }

  fn prepend(&self, other: Self::ParentChild) {
    self.node.prepend(other.node);
  }

  fn after(&self, node: <Self as Node>::ParentChild) {
    self.node.insert_after(node.node);
  }

  fn before(&self, node: <Self as Node>::ParentChild) -> Option<()> {
    self.node.insert_before(node.node);
    Some(())
  }
}

impl<'arena> selectors::Element for OxvgNode<'arena> {
  type Impl = oxvg_ast::selectors::SelectorImpl<
    <Self as Node>::Atom,
    <<Self as Element>::Name as Name>::LocalName,
    <<Self as Element>::Name as Name>::Namespace,
  >;

  fn opaque(&self) -> selectors::OpaqueElement {
    selectors::OpaqueElement::new(self)
  }

  fn parent_element(&self) -> Option<Self> {
    Element::parent_element(self)
  }

  fn parent_node_is_shadow_root(&self) -> bool {
    false
  }

  fn containing_shadow_host(&self) -> Option<Self> {
    None
  }

  fn is_pseudo_element(&self) -> bool {
    false
  }

  fn prev_sibling_element(&self) -> Option<Self> {
    Element::previous_element_sibling(self)
  }

  fn next_sibling_element(&self) -> Option<Self> {
    Element::next_element_sibling(self)
  }

  fn first_element_child(&self) -> Option<Self> {
    self.children().first().cloned()
  }

  fn is_html_element_in_html_document(&self) -> bool {
    true
  }

  fn has_local_name(
    &self,
    local_name: &<Self::Impl as selectors::SelectorImpl>::BorrowedLocalName,
  ) -> bool {
    if self.node_type() == node::Type::Document {
      false
    } else {
      self.local_name() == &local_name.0
    }
  }

  fn has_namespace(
    &self,
    ns: &<Self::Impl as selectors::SelectorImpl>::BorrowedNamespaceUrl,
  ) -> bool {
    self.qual_name().ns() == &ns.0
  }

  fn is_same_type(&self, other: &Self) -> bool {
    let name = self.qual_name();
    let other_name = other.qual_name();

    name.local_name() == other_name.local_name() && name.prefix() == other_name.prefix()
  }

  fn attr_matches(
    &self,
    ns: &selectors::attr::NamespaceConstraint<
      &<Self::Impl as selectors::SelectorImpl>::NamespaceUrl,
    >,
    local_name: &<Self::Impl as selectors::SelectorImpl>::LocalName,
    operation: &selectors::attr::AttrSelectorOperation<
      &<Self::Impl as selectors::SelectorImpl>::AttrValue,
    >,
  ) -> bool {
    use selectors::attr::NamespaceConstraint;

    let value = match ns {
      NamespaceConstraint::Any => self.get_attribute_local(&local_name.0),
      NamespaceConstraint::Specific(ns) => self.get_attribute_ns(&ns.0, &local_name.0),
    };
    let Some(value) = value else {
      return false;
    };
    let string = value.as_ref();
    operation.eval_str(string)
  }

  fn match_non_ts_pseudo_class(
    &self,
    pc: &<Self::Impl as selectors::SelectorImpl>::NonTSPseudoClass,
    _context: &mut selectors::context::MatchingContext<Self::Impl>,
  ) -> bool {
    use oxvg_ast::selectors::PseudoClass;

    match pc {
      PseudoClass::Link(..) | PseudoClass::AnyLink(..) => self.is_link(),
    }
  }

  fn match_pseudo_element(
    &self,
    _pe: &<Self::Impl as selectors::SelectorImpl>::PseudoElement,
    _context: &mut selectors::context::MatchingContext<Self::Impl>,
  ) -> bool {
    false
  }

  fn apply_selector_flags(&self, _flags: selectors::matching::ElementSelectorFlags) {
    // TODO: seems unused?
  }

  fn is_link(&self) -> bool {
    if self.node_type() == node::Type::Document {
      return false;
    }
    matches!(
      self.local_name(),
      &local_name!("a") | &local_name!("area") | &local_name!("link")
    ) && self.has_attribute_local(&local_name!("href"))
  }

  fn is_html_slot_element(&self) -> bool {
    false
  }

  fn has_id(
    &self,
    id: &<Self::Impl as selectors::SelectorImpl>::Identifier,
    case_sensitivity: selectors::attr::CaseSensitivity,
  ) -> bool {
    let Some(self_id) = self.get_attribute_local(&local_name!("id")) else {
      return false;
    };
    case_sensitivity.eq(id.0.as_bytes(), self_id.as_bytes())
  }

  fn has_class(
    &self,
    name: &<Self::Impl as selectors::SelectorImpl>::Identifier,
    case_sensitivity: selectors::attr::CaseSensitivity,
  ) -> bool {
    if self.node_type() == node::Type::Document {
      return false;
    }

    let Some(self_class) = self.get_attribute_local(&local_name!("class")) else {
      return false;
    };
    let name = name.0.as_bytes();
    self_class
      .split_whitespace()
      .any(|c| case_sensitivity.eq(name, c.as_bytes()))
  }

  fn imported_part(
    &self,
    _name: &<Self::Impl as selectors::SelectorImpl>::Identifier,
  ) -> Option<<Self::Impl as selectors::SelectorImpl>::Identifier> {
    None
  }

  fn is_part(&self, _name: &<Self::Impl as selectors::SelectorImpl>::Identifier) -> bool {
    false
  }

  fn is_empty(&self) -> bool {
    !self.has_child_nodes()
      || self.all_children(|child| match &child.node.data {
        NodeData::Text { contents } => contents.borrow().trim().is_empty(),
        _ => false,
      })
  }

  fn is_root(&self) -> bool {
    let Some(parent) = self.parent_node() else {
      return true;
    };
    parent.node_type() == node::Type::Document
  }

  fn has_custom_state(&self, _name: &<Self::Impl as selectors::SelectorImpl>::Identifier) -> bool {
    false
  }

  #[allow(clippy::cast_possible_truncation)]
  fn add_element_unique_hashes(&self, filter: &mut selectors::bloom::BloomFilter) -> bool {
    let mut f = |hash: u32| filter.insert_hash(hash & selectors::bloom::BLOOM_HASH_MASK);

    let local_name_hash = &mut DefaultHasher::default();
    self.local_name().hash(local_name_hash);
    f(local_name_hash.finish() as u32);

    let prefix_hash = &mut DefaultHasher::default();
    self.prefix().hash(prefix_hash);
    f(prefix_hash.finish() as u32);

    if let Some(id) = self.get_attribute(&QualName {
      prefix: None,
      ns: Namespace::default(),
      local: local_name!("id"),
    }) {
      let id_hash = &mut DefaultHasher::default();
      id.hash(id_hash);
      f(prefix_hash.finish() as u32);
    }

    for class in self.class_list().iter() {
      let class_hash = &mut DefaultHasher::default();
      class.hash(class_hash);
      f(class_hash.finish() as u32);
    }

    for attr in self.attributes().into_iter() {
      let name = attr.name();
      if matches!(name.local_name().as_ref(), "class" | "id" | "style") {
        continue;
      }

      let name_hash = &mut DefaultHasher::default();
      name.hash(name_hash);
      f(name_hash.finish() as u32);
    }
    true
  }
}

impl<'arena> oxvg_ast::element::Features for OxvgNode<'arena> {}

impl<'arena> Document for OxvgNode<'arena> {
  type Root = OxvgNode<'arena>;

  fn document_element(&self) -> &Self::Root {
    self
  }

  fn create_attribute<'a>(
    &self,
    name: <<<Self::Root as Element>::Attributes<'a> as Attributes<'a>>::Attribute as Attr>::Name,
  ) -> <<Self::Root as Element>::Attributes<'a> as Attributes<'a>>::Attribute {
    Attribute {
      name,
      value: StrTendril::default(),
    }
  }

  fn create_c_data_section(&self, data: <Self::Root as Node>::Atom) -> <Self::Root as Node>::Child {
    let node = self.arena.alloc(crate::arena::Node::new(
      NodeData::Text {
        contents: RefCell::new(data),
      },
      0,
    ));
    OxvgNode {
      node,
      arena: self.arena,
    }
  }

  fn create_element(&self, tag_name: <Self::Root as Element>::Name) -> Self::Root {
    let node = self.arena.alloc(crate::arena::Node::new(
      NodeData::Element {
        name: tag_name,
        attrs: RefCell::new(vec![]),
        template_contents: None,
        mathml_annotation_xml_integration_point: false,
      },
      0,
    ));
    OxvgNode {
      node,
      arena: self.arena,
    }
  }

  fn create_processing_instruction(
    &self,
    target: <Self::Root as Node>::Atom,
    data: <Self::Root as Node>::Atom,
  ) -> <<Self::Root as Node>::Child as Node>::ParentChild {
    let node = self.arena.alloc(crate::arena::Node::new(
      NodeData::ProcessingInstruction {
        target,
        contents: RefCell::new(data),
      },
      0,
    ));
    OxvgNode {
      node,
      arena: self.arena,
    }
  }

  fn create_text_node(&self, data: <Self::Root as Node>::Atom) -> <Self::Root as Node>::Child {
    let node = self.arena.alloc(crate::arena::Node::new(
      NodeData::Text {
        contents: RefCell::new(data),
      },
      0,
    ));
    OxvgNode {
      node,
      arena: self.arena,
    }
  }
}
