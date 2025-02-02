/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* @flow */
import {StackFrame} from './stack-frame';
import {parse} from './parser';

/**
 * Enhances a set of <code>StackFrame</code>s with their original positions and code (when available).
 * @param {StackFrame[]} frames A set of <code>StackFrame</code>s which contain (generated) code positions.
 * @param {number} [contextLines=3] The number of lines to provide before and after the line specified in the <code>StackFrame</code>.
 */
async function getStackFrames(
  error: Error,
  contextLines: number = 3,
): Promise<StackFrame[] | null> {
  const frames = parse(error);
  // $FlowFixMe
  let res = await fetch(import.meta.devServer + '/__parcel_code_frame', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      contextLines,
      frames: frames.map(f => ({
        fileName: f.fileName,
        lineNumber: f.lineNumber,
        columnNumber: f.columnNumber,
      })),
    }),
  });

  let json = await res.json();
  return json.map(
    (f, i) =>
      new StackFrame(
        frames[i].functionName,
        f.fileName,
        f.lineNumber,
        f.columnNumber,
        f.compiledLines,
        frames[i].functionName,
        f.sourceFileName,
        f.sourceLineNumber,
        f.sourceColumnNumber,
        f.sourceLines,
      ),
  );
}

export default getStackFrames;
export {getStackFrames};
