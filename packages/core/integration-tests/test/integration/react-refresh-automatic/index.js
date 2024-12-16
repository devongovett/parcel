import { useState } from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { act } from "react-dom/test-utils";

let Main = () => {
  const [x] = useState(Math.random());

  return (
    <div>
      <span>{x}</span> <App />
    </div>
  );
};

export default () =>
  act(async () => {ReactDOM.createRoot(document.getElementById("root")).render(<Main />);});
