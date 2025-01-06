'use server-entry';

import {readFile, stat} from 'fs/promises';
import {Files} from './Files';
import Container from './Container';
import {Counter} from './Counter';
import './bootstrap';

export default async function FilePage({file}) {
  let f = await stat(file);
  let contents = f.isFile() ? (
    await readFile(file, 'utf8')
  ) : (
    <Files dir={file} />
  );
  return (
    <html>
      <head>
        <title>{file}</title>
      </head>
      <body>
        <Container>
          <h1>{file}</h1>
          <Counter />
          <pre>{contents}</pre>
        </Container>
      </body>
    </html>
  );
}
