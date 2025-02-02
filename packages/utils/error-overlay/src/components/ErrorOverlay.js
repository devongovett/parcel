/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* eslint-env browser */
/* @flow */
import React, {useEffect} from 'react';
import {theme} from '../styles';

import type {Node as ReactNode} from 'react';

const overlayStyle = {
  position: 'relative',
  display: 'inline-flex',
  flexDirection: 'column',
  height: '100%',
  width: '1024px',
  maxWidth: '100%',
  overflowX: 'hidden',
  overflowY: 'auto',
  padding: '0.5rem',
  boxSizing: 'border-box',
  textAlign: 'left',
  fontFamily: 'Consolas, Menlo, monospace',
  fontSize: '11px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  lineHeight: 1.5,
  color: theme.color,
};

type ErrorOverlayPropsType = {|
  children: ReactNode,
  shortcutHandler?: (eventKey: string) => void,
|};

function ErrorOverlay(props: ErrorOverlayPropsType): React$Element<'div'> {
  const {shortcutHandler} = props;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (shortcutHandler) {
        shortcutHandler(e.key);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [shortcutHandler]);

  return <div style={overlayStyle}>{props.children}</div>;
}

export default ErrorOverlay;
