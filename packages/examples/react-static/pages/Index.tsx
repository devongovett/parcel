import type { PageProps } from "../types";
import { Resources } from "@parcel/runtime-rsc";
import { Counter } from "../components/Counter";
import { Nav } from '../components/Nav';
import '../components/style.css';
import '../components/client';

export default function Index({pages, currentPage}: PageProps) {
  return (
    <html>
      <head>
        <title>Static RSC</title>
        <Resources />
      </head>
      <body>
        <h1>This is an RSC!</h1>
        <Nav pages={pages} currentPage={currentPage} />
        <Counter />
      </body>
    </html>
  );
}
