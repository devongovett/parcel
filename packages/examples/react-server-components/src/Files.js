import fs from 'fs/promises';
import path from 'path';

export async function Files({dir = process.cwd()}) {
  // await new Promise(resolve => setTimeout(resolve, 1000));
  let files = await fs.readdir(dir);
  let relative = path.relative(process.cwd(), dir);
  return (
    <ul>
      {files.map((file, i) => <li key={i}><a href={`/files/${path.join(relative, file)}`}>{file}</a></li>)}
    </ul>
  );
}
