/* @jsxRuntime automatic */
/* eslint-disable react/prop-types */
/* eslint-disable react/react-in-jsx-scope */

function CodeBlock({lang, children, render}) {
  return (
    <>
      <pre>
        <code className={lang ? `language-${lang}` : undefined}>
          {children}
        </code>
      </pre>
      {render}
    </>
  );
}

const components = {
  CodeBlock
};

export function useMDXComponents() {
  return components;
}
