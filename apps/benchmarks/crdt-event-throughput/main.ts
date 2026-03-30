import "../src/styles.css";
import { renderCrdtEventThroughputShell } from "./benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

renderCrdtEventThroughputShell(rootElement);
