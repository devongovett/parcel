import type { PageProps } from "../types";
import './Nav.css';

export function Nav({pages, currentPage}: PageProps) {
  return (
    <nav>
      <h3>Navigation</h3>
      <p><code>components/Nav.tsx</code> shows how to render a list of pages.</p>
      <ul>
        {pages.map(page => (
          <li key={page.url}>
            <a href={page.url} aria-current={page.url === currentPage.url ? 'page' : undefined}>
              {page.name}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
