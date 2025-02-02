/**
 * Copyright (c) 2015-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

/* @flow */

import {theme} from '../styles';
import ansiHTML from 'ansi-html-community';

// Map ANSI colors from what babel-code-frame uses to base16-github
// See: https://github.com/babel/babel/blob/e86f62b304d280d0bab52c38d61842b853848ba6/packages/babel-code-frame/src/index.js#L9-L22
const colors = {
  reset: [theme.base05, 'transparent'],
  black: theme.base05,
  red: theme.base08 /* marker, bg-invalid */,
  green: theme.base0B /* string */,
  yellow: theme.base08 /* capitalized, jsx_tag, punctuator */,
  blue: theme.base0C,
  magenta: theme.base0C /* regex */,
  cyan: theme.base0E /* keyword */,
  gray: theme.base03 /* comment, gutter */,
  lightgrey: theme.base01,
  darkgrey: theme.base03,
};

// $FlowFixMe
ansiHTML.setColors(colors);
// $FlowFixMe
for (let tag in ansiHTML.tags.open) {
  // $FlowFixMe
  ansiHTML.tags.open[tag] = ansiHTML.tags.open[tag].replace(
    /#light-dark/g,
    'light-dark',
  );
}

function generateAnsiHTML(txt: string): string {
  return ansiHTML(
    txt.replace(/[&<>"']/g, c => {
      switch (c) {
        case '&':
          return '&amp';
        case '<':
          return '&lt;';
        case '>':
          return '&gt';
        case '"':
          return '&quot;';
        case "'":
          return '&#39;';
        default:
          return c;
      }
    }),
  );
}

export default generateAnsiHTML;
