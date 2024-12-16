import * as React from "react";
import * as ReactDOM from "react-dom/client";

type Props = {
  bar: string;
};

function App(props: Props) {
  return <div>{props.bar}</div>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App bar="bar" />);
