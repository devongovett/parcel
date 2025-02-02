/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* @flow */
import React, {useState} from 'react';
import {theme} from '../styles';
import CodeBlock from '../components/CodeBlock';
import {getPrettyURL} from '../utils/getPrettyURL';

import type {StackFrame as StackFrameType} from '../utils/stack-frame';
import type {ErrorLocation} from '..';
import generateAnsiHTML from '../utils/generateAnsiHTML';

const linkStyle = {
  fontSize: '0.9em',
  marginBottom: '0.9em',
};

const anchorStyle = {
  textDecoration: 'none',
  color: theme.anchorColor,
  cursor: 'pointer',
};

const codeAnchorStyle = {
  cursor: 'pointer',
};

const toggleStyle = {
  color: theme.toggleColor,
  cursor: 'pointer',
  border: 'none',
  display: 'block',
  width: '100%',
  textAlign: 'left',
  background: theme.toggleBackground,
  fontFamily: 'Consolas, Menlo, monospace',
  fontSize: '1em',
  padding: '0px',
  lineHeight: '1.5',
};

type StackFramePropsType = {|
  frame: StackFrameType,
  contextSize: number,
  critical: boolean,
  showCode: boolean,
  editorHandler?: ?(errorLoc: ErrorLocation) => void,
|};

function StackFrame(props: StackFramePropsType): React$Element<'div'> {
  const {frame, critical, showCode} = props;
  const {
    fileName,
    lineNumber,
    columnNumber,
    _scriptCode: scriptLines,
    _originalFileName: sourceFileName,
    _originalLineNumber: sourceLineNumber,
    _originalColumnNumber: sourceColumnNumber,
    _originalScriptCode: sourceLines,
  } = frame;
  const functionName = frame.getFunctionName();

  const [compiled, setCompiled] = useState(!sourceLines);

  const toggleCompiled = () => {
    setCompiled(!compiled);
  };

  const getErrorLocation = (): ErrorLocation | null => {
    const {_originalFileName: fileName, _originalLineNumber: lineNumber} =
      props.frame;
    // Unknown file
    if (!fileName) {
      return null;
    }
    // e.g. "/path-to-my-app/webpack/bootstrap eaddeb46b67d75e4dfc1"
    const isInternalWebpackBootstrapCode = fileName.trim().indexOf(' ') !== -1;
    if (isInternalWebpackBootstrapCode) {
      return null;
    }
    // Code is in a real file
    return {fileName, lineNumber: lineNumber || 1};
  };

  const editorHandler = () => {
    const errorLoc = getErrorLocation();
    if (!errorLoc) {
      return;
    }
    props.editorHandler?.(errorLoc);
  };

  const onKeyDown = (e: SyntheticKeyboardEvent<any>) => {
    if (e.key === 'Enter') {
      editorHandler();
    }
  };

  const url = getPrettyURL(
    sourceFileName,
    sourceLineNumber,
    sourceColumnNumber,
    fileName,
    lineNumber,
    columnNumber,
    compiled,
  );

  let codeBlockProps = null;
  if (showCode) {
    if (
      compiled &&
      scriptLines &&
      scriptLines.length !== 0 &&
      lineNumber != null
    ) {
      codeBlockProps = {
        codeHTML: generateAnsiHTML(scriptLines),
        main: critical,
      };
    } else if (
      !compiled &&
      sourceLines &&
      sourceLines.length !== 0 &&
      sourceLineNumber != null
    ) {
      codeBlockProps = {
        codeHTML: generateAnsiHTML(sourceLines),
        main: critical,
      };
    }
  }

  const canOpenInEditor =
    getErrorLocation() !== null && props.editorHandler !== null;
  return (
    <div>
      <div>{functionName}</div>
      <div style={linkStyle}>
        <span
          role="link"
          style={canOpenInEditor ? anchorStyle : null}
          onClick={canOpenInEditor ? editorHandler : null}
          onKeyDown={canOpenInEditor ? onKeyDown : null}
          tabIndex={canOpenInEditor ? '0' : null}
        >
          {url}
        </span>
      </div>
      {codeBlockProps && (
        <div style={{marginBottom: '1.5em'}}>
          <span
            onClick={canOpenInEditor ? editorHandler : null}
            style={canOpenInEditor ? codeAnchorStyle : null}
          >
            <CodeBlock {...codeBlockProps} />
          </span>
          {scriptLines && sourceLines && (
            <button style={toggleStyle} onClick={toggleCompiled}>
              {'View ' + (compiled ? 'source' : 'compiled')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default StackFrame;
