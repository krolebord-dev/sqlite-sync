import "../src/styles.css";
import { renderLocalWriteOverheadShell } from "./benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

renderLocalWriteOverheadShell(rootElement);
