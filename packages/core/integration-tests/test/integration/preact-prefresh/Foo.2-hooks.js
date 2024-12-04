import { h } from 'preact';
import { useState } from "preact/hooks";

let Foo = () => {
  const [x] = useState(Math.random());
  const [y] = useState(Math.random());

  return (
    <div>
      Hooks:{x}:{y}
    </div>
  );
};

export default Foo;
