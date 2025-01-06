/* eslint-env browser */
/* eslint-disable react/react-in-jsx-scope */
/* @jsxRuntime automatic */

export function createResourcesProxy(module, resources, bootstrapScript) {
  return new Proxy(module, {
    get(target, prop, receiver) {
      let value = Reflect.get(target, prop, receiver);
      return createResourcesValueProxy(value, resources, bootstrapScript);
    },
  });
}

let cache = new WeakMap();
function createResourcesValueProxy(value, resources, bootstrapScript) {
  if (typeof value === 'function') {
    let cached = cache.get(value);
    if (cached) {
      return cached;
    }

    // Detect reads of `Component.prototype.isReactComponent` or `Component.$$typeof`
    // prior to the function being called as an indication that this is a React component.
    // If so, inject the resources as a sibling of the return value.
    let isReactComponent = false;
    let prototypeProxy;
    if (typeof value.prototype === 'object') {
      prototypeProxy = new Proxy(value.prototype, {
        get(target, prop, receiver) {
          if (prop === 'isReactComponent') {
            isReactComponent = true;
          }
          return Reflect.get(target, prop, receiver);
        }
      });
    }

    let proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (prototypeProxy && prop === 'prototype') {
          return prototypeProxy;
        }

        if (prop === '$$typeof') {
          isReactComponent = true;
        }

        if (bootstrapScript && prop === 'bootstrapScript') {
          return bootstrapScript;
        }

        return Reflect.get(target, prop, receiver);
      },
      apply(target, thisArg, args) {
        let result = Reflect.apply(target, thisArg, args);
        if (isReactComponent) {
          return <>{resources}{result}</>
        }
        return result;
      }
    });

    cache.set(value, proxy);
    return proxy;
  } else if (value && typeof value === 'object') {
    let cached = cache.get(value);
    if (cached) {
      return cached;
    }

    let proxy = new Proxy(value, {
      get(target, prop, receiver) {
        let value = Reflect.get(target, prop, receiver);
        return createResourcesValueProxy(value, resources, bootstrapScript);
      }
    });

    cache.set(value, proxy);
    return proxy;
  }

  return value;
}

export function waitForCSS(url) {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') {
      return resolve();
    }

    // Find a link element corresponding to this URL.
    let link = document.querySelector(`link[rel="stylesheet"][href="${CSS.escape(url)}"]`);
    if (!link) {
      return resolve();
    }

    // If the link element already has a stylesheet associated with it, then it is already loaded.
    if (link.sheet) {
      return resolve();
    }

    link.addEventListener('load', () => {
      resolve();
    });

    link.addEventListener('error', e => {
      reject(e);
    });
  });
}
