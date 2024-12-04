import { h } from "preact";
import { useState } from "preact/hooks";
import Foo from "./Foo";

export const App = () => {
  const [x] = useState(Math.random());

  return (
    <div>
      {x} <Foo />
    </div>
  );
};
