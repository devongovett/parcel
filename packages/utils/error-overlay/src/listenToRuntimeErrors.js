/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* eslint-env browser */
/** @flow */
import {
  register as registerError,
  unregister as unregisterError,
} from './effects/unhandledError';
import {
  register as registerPromise,
  unregister as unregisterPromise,
} from './effects/unhandledRejection';
import {
  register as registerStackTraceLimit,
  unregister as unregisterStackTraceLimit,
} from './effects/stackTraceLimit';
import getStackFrames from './utils/getStackFrames';
import type {StackFrame} from './utils/stack-frame';
import React from 'react';

const CONTEXT_SIZE: number = 3;

export type ErrorRecord = {|
  error: Error,
  unhandledRejection: boolean,
  contextSize: number,
  stackFrames: StackFrame[],
|};

export function crashWithFrames(
  crash: ErrorRecord => void,
): (Error, boolean) => void {
  return (error: Error, unhandledRejection = false) => {
    getStackFrames(error, CONTEXT_SIZE)
      .then(stackFrames => {
        if (stackFrames == null) {
          return;
        }
        crash({
          error,
          unhandledRejection,
          contextSize: CONTEXT_SIZE,
          stackFrames,
        });
      })
      .catch(e => {
        // eslint-disable-next-line no-console
        console.log('Could not get the stack frames of error:', e);
      });
  };
}

function patchConsole(method: string, onError: (err: Error) => void) {
  /* eslint-disable no-console */
  let original = console[method];
  console[method] = (...args) => {
    let error = null;
    if (typeof args[0] === 'string') {
      let format = args[0].match(/%[oOdisfc]/g);
      if (format) {
        let errorIndex = format.findIndex(
          match => match === '%o' || match === '%O',
        );
        if (errorIndex < 0) {
          errorIndex = format.findIndex(match => match === '%s');
        }
        if (errorIndex >= 0) {
          error = args[errorIndex + 1];
        } else {
          error = args[1];
        }

        if (!(error instanceof Error)) {
          let index = 1;
          let message = args[0].replace(/%[oOdisfc]/g, match => {
            switch (match) {
              case '%s':
                return String(args[index++]);
              case '%f':
                return parseFloat(args[index++]);
              case '%d':
              case '%i':
                return parseInt(args[index++], 10);
              case '%o':
              case '%O':
                if (args[index] instanceof Error) {
                  return String(args[index++]);
                } else {
                  return JSON.stringify(args[index++]);
                }
              case '%c':
                index++;
                return '';
            }
          });

          error = new Error(message);
        }
      } else {
        error = new Error(args[0]);
      }
    } else {
      error = args.find(arg => arg instanceof Error);
    }

    if (error && !error.message.includes('[parcel]')) {
      // Attempt to append the React component stack
      // $FlowFixMe
      if (typeof React.captureOwnerStack === 'function') {
        // $FlowFixMe
        let stack = React.captureOwnerStack();
        error.stack += stack;
      } else {
        const ReactSharedInternals =
          // $FlowFixMe
          React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE ||
          // $FlowFixMe
          React.__SERVER_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

        if (typeof ReactSharedInternals?.getCurrentStack === 'function') {
          // $FlowFixMe
          let stack = ReactSharedInternals.getCurrentStack();
          error.stack += stack;
        }
      }

      onError(error);
    }

    original.apply(console, args);
  };
  /* eslint-enable no-console */
}

export function listenToRuntimeErrors(crash: ErrorRecord => void): () => void {
  const crashWithFramesRunTime = crashWithFrames(crash);

  registerError(window, error => crashWithFramesRunTime(error, false));
  registerPromise(window, error => crashWithFramesRunTime(error, true));
  registerStackTraceLimit();
  patchConsole('error', error => crashWithFramesRunTime(error, false));

  return function stopListening() {
    unregisterStackTraceLimit();
    unregisterPromise(window);
    unregisterError(window);
  };
}
