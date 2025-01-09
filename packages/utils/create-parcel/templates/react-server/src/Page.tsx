"use server-entry";

import './page.css';
import './client';
import { Counter } from './Counter';
import { action, name } from './actions';

export async function Page() {
  return (
    <html lang="en">
      <head>
        <title>Parcel React Server App</title>
      </head>
      <body>
        <h1>Parcel React Server App</h1>
        <p>This page is a React Server Component! Edit <code>src/Page.tsx</code> to get started.</p>
        <p>Here is a client component: <Counter /></p>
        <hr />
        <p>This form submits a server action.</p>
        <form action={action}>
          <label>Enter your name: <input name="name" defaultValue={name} /></label>
          <button>Submit</button>
        </form>
        {name && <p>Welcome {name}!</p>}
      </body>
    </html>
  );
}
