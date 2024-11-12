async function load(id) {
  if (!parcelRequire.retryState) {
    parcelRequire.retryState = {};
  }

  if (!globalThis.navigator.onLine) {
    await new Promise(res =>
      globalThis.addEventListener('online', res, {once: true}),
    );
  }

  let url = require('../bundle-manifest').resolve(id);

  if (parcelRequire.retryState[id] != undefined) {
    url = `${url}?retry=${parcelRequire.retryState[id]}`;
  }

  try {
    // eslint-disable-next-line no-undef
    return await __parcel__import__(url);
  } catch (error) {
    parcelRequire.retryState[id] = Date.now();
  }
}

module.exports = load;
