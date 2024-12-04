import { h } from "preact";
import { useState } from "preact/hooks";

let Foo = () => {
  const [x] = useState(Math.random());

  return (
    <div>
      Functional:{x}
    </div>
  );
};

export default Foo;
