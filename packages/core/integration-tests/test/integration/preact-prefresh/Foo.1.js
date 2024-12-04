import { h } from "preact";
import { useState } from "preact/hooks";

let Foo = () => {
  const [x] = useState(Math.random());
  console.log('Foo.1', x);

  return (
    <div>
      OtherFunctional:{x}
    </div>
  );
};

export default Foo;
