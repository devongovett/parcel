/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* @flow */
import React, {useState} from 'react';
import {theme} from '../styles';

import type {Element as ReactElement} from 'react';

const _collapsibleStyle = {
  cursor: 'pointer',
  border: 'none',
  display: 'block',
  width: '100%',
  textAlign: 'left',
  fontFamily: 'Consolas, Menlo, monospace',
  fontSize: '1em',
  padding: '0px',
  lineHeight: '1.5',
};

const collapsibleCollapsedStyle = {
  ..._collapsibleStyle,
  color: theme.color,
  background: theme.background,
  marginBottom: '1.5em',
};

const collapsibleExpandedStyle = {
  ..._collapsibleStyle,
  color: theme.color,
  background: theme.background,
  marginBottom: '0.6em',
};

type CollapsiblePropsType = {|
  children: ReactElement<any>[],
|};

function Collapsible(props: CollapsiblePropsType): React$Element<'details'> {
  const [collapsed, setCollapsed] = useState(true);

  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
  };

  const count = props.children.length;
  return (
    <details open={!collapsed} onToggle={toggleCollapsed}>
      <summary
        style={collapsed ? collapsibleCollapsedStyle : collapsibleExpandedStyle}
      >
        {(collapsed ? '▶' : '▼') +
          ` ${count} stack frames were ` +
          (collapsed ? 'collapsed.' : 'expanded.')}
      </summary>
      <div>
        {props.children}
        <button onClick={toggleCollapsed} style={collapsibleExpandedStyle}>
          {`▲ ${count} stack frames were expanded.`}
        </button>
      </div>
    </details>
  );
}

export default Collapsible;
