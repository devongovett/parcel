import { h, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { App } from "./App";

let Main = () => {
  const [x] = useState(Math.random());

  return (
    <div>
      <span>{x}</span> <App />
    </div>
  );
};

export default () => act(async () => {
  render(<Main />, document.getElementById("root"));
});
