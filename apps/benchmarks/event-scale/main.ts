import "../src/styles.css";
import { renderEventScaleShell } from "./benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

renderEventScaleShell(rootElement);
