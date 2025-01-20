'use client-entry';

import {hydrate, fetchRSC} from '@parcel/rsc/client';

let updateRoot = hydrate({
  async handleServerAction(id, args) {
    console.log(id, args);
    const {result, root} = await fetchRSC('/', {
      method: 'POST',
      headers: {
        'rsc-action-id': id,
      },
      body: args,
    });
    updateRoot(root);
    return result;
  },
  onHmrReload() {
    navigate(location.pathname);
  },
});

// A very simple router. When we navigate, we'll fetch a new RSC payload from the server,
// and in a React transition, stream in the new page. Once complete, we'll pushState to
// update the URL in the browser.
async function navigate(pathname, push) {
  let root = await fetchRSC(pathname);
  updateRoot(root, () => {
    if (push) {
      history.pushState(null, '', pathname);
    }
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
