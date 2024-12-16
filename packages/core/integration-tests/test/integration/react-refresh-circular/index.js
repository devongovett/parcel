import ReactDOM from "react-dom/client";
import { App } from "./App";
import { act } from "react-dom/test-utils";

export default () =>
  act(async () => {ReactDOM.createRoot(document.getElementById("root")).render(<App />);});
