import React, { useState } from "react";

let Foo = () => {
  const [x] = useState(Math.random());
  console.log('Foo', x);

  return (
    <div>
      Functional:{x}
    </div>
  );
};

export default Foo;
