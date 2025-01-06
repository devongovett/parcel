/* eslint-disable import/no-extraneous-dependencies */
import * as ReactJSXRuntime from 'react/jsx-runtime';

export * from 'react/jsx-runtime';

const resourcesSymbol = Symbol.for('react.resources');

export function jsx(type, props, key) {
  let el = ReactJSXRuntime.jsx(type, props, key);

  // If the component has resources (e.g. CSS) attached, render it in a fragment.
  if (type?.[resourcesSymbol]) {
    return ReactJSXRuntime.jsx(
      ReactJSXRuntime.Fragment,
      {
        ...props,
        children: [type[resourcesSymbol], el],
      },
      key,
    );
  }

  return el;
}

export {jsx as jsxs};
