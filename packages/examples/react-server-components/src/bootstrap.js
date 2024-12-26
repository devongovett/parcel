'use client-entry';

import {useState, use, startTransition, useInsertionEffect} from 'react';
import ReactDOM from 'react-dom/client';
import {
  createFromReadableStream,
  createFromFetch,
  encodeReply,
  setServerCallback,
} from 'react-server-dom-parcel/client';
import {rscStream} from 'rsc-html-stream/client';

// Stream in initial RSC payload embedded in the HTML.
let data = createFromReadableStream(rscStream);
let updateRoot;

// Setup a callback to perform server actions.
// This sends a POST request to the server, and updates the page with the response.
setServerCallback(async function (id, args) {
  console.log(id, args);
  const response = fetch('/', {
    method: 'POST',
    headers: {
      Accept: 'text/x-component',
      'rsc-action-id': id,
    },
    body: await encodeReply(args),
  });
  const {result, root} = await createFromFetch(response);
  startTransition(() => updateRoot(root));
  return result;
});

function Content() {
  // Store the current root element in state, along with a callback
  // to call once rendering is complete.
  let [[root, cb], setRoot] = useState([use(data), null]);
  updateRoot = (root, cb) => setRoot([root, cb]);
  useInsertionEffect(() => cb?.());
  return root;
}

// Hydrate initial page content.
startTransition(() => {
  ReactDOM.hydrateRoot(document, <Content />);
});

// A very simple router. When we navigate, we'll fetch a new RSC payload from the server,
// and in a React transition, stream in the new page. Once complete, we'll pushState to
// update the URL in the browser.
async function navigate(pathname, push) {
  let res = fetch(pathname, {
    headers: {
      Accept: 'text/x-component',
    },
  });
  let root = await createFromFetch(res);
  startTransition(() => {
    updateRoot(root, () => {
      if (push) {
        history.pushState(null, '', pathname);
        push = false;
      }
    });
  });
}

// Intercept link clicks to perform RSC navigation.
document.addEventListener('click', e => {
  let link = e.target.closest('a');
  if (
    link &&
    link instanceof HTMLAnchorElement &&
    link.href &&
    (!link.target || link.target === '_self') &&
    link.origin === location.origin &&
    !link.hasAttribute('download') &&
    e.button === 0 && // left clicks only
    !e.metaKey && // open in new tab (mac)
    !e.ctrlKey && // open in new tab (windows)
    !e.altKey && // download
    !e.shiftKey &&
    !e.defaultPrevented
  ) {
    e.preventDefault();
    navigate(link.pathname, true);
  }
});

// When the user clicks the back button, navigate with RSC.
window.addEventListener('popstate', e => {
  navigate(location.pathname);
});

// Intercept HMR window reloads, and do it with RSC instead.
window.addEventListener('parcelhmrreload', e => {
  e.preventDefault();
  navigate(location.pathname);
});
