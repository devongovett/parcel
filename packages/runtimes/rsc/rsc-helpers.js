const resourcesSymbol = Symbol.for('react.resources');

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
  if (typeof value === 'function' || (typeof value === 'object' && value)) {
    let cached = cache.get(value);
    if (cached) {
      return cached;
    }

    let proxy = new Proxy(value, {
      get(target, prop, receiver) {
        if (prop === resourcesSymbol) {
          return resources;
        }

        if (bootstrapScript && prop === 'bootstrapScript') {
          return bootstrapScript;
        }

        return createResourcesValueProxy(
          Reflect.get(target, prop, receiver),
          resources,
        );
      },
    });

    cache.set(value, proxy);
    return proxy;
  }

  return value;
}
