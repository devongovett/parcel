/* eslint-disable import/no-extraneous-dependencies */
import * as ReactJSXRuntime from 'react/jsx-dev-runtime';

export * from 'react/jsx-dev-runtime';

const resourcesSymbol = Symbol.for('react.resources');

export function jsxDEV(type, props, key, isStatic, source, self) {
  let el = ReactJSXRuntime.jsxDEV(type, props, key, isStatic, source, self);
  if (type?.[resourcesSymbol]) {
    return ReactJSXRuntime.jsxDEV(
      ReactJSXRuntime.Fragment,
      {
        ...props,
        children: [type[resourcesSymbol], el],
      },
      key,
      true,
      source,
      self,
    );
  }

  return el;
}
