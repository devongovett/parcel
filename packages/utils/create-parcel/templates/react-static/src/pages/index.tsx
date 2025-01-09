import type { PageProps } from '../types';
import { Nav } from '../components/Nav';
import { Counter } from '../components/Counter';
import '../page.css';
import '../client';

export default function Index({pages, currentPage}: PageProps) {
  return (
    <html lang="en">
      <head>
        <title>Parcel Static React App</title>
      </head>
      <body>
        <h1>Parcel Static React App</h1>
        <p>This page is a React Server Component that is statically rendered at build time. Edit <code>pages/index.tsx</code> to get started.</p>
        <p>Here is a client component: <Counter /></p>
        <Nav pages={pages} currentPage={currentPage} />
      </body>
    </html>
  );
}
