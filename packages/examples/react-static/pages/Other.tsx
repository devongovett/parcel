import type { PageProps } from "../types";
import {Nav} from '../components/Nav';
import '../components/style.css';
import '../components/client';

export default function Index({pages, currentPage}: PageProps) {
  return (
    <html>
      <head>
        <title>Static RSC</title>
      </head>
      <body>
        <h1>This is another RSC!</h1>
        <Nav pages={pages} currentPage={currentPage} />
      </body>
    </html>
  );
}
