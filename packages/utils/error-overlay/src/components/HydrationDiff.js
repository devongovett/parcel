/** @flow */
import React from 'react';
import {theme} from '../styles';

const diffStyle = {
  backgroundColor: theme.primaryPreBackground,
  color: theme.primaryPreColor,
  padding: '0.5em',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
  borderRadius: '0.25rem',
};

export default function HydrationDiff({
  diff,
}: {|
  diff: string,
|}): React$Element<'pre'> {
  let lines = diff
    .split('\n')
    .flatMap((line, i) => [formatLine(line, i), '\n'])
    .slice(0, -1);
  return <pre style={diffStyle}>{lines}</pre>;
}

function formatLine(line: string, index: number) {
  if (line.startsWith('+')) {
    return (
      <span key={index} style={{color: theme.diffAdded, fontWeight: 'bold'}}>
        {line}
      </span>
    );
  } else if (line.startsWith('-') || line.startsWith('>')) {
    return (
      <span key={index} style={{color: theme.diffRemoved, fontWeight: 'bold'}}>
        {line}
      </span>
    );
  } else {
    return line;
  }
}
