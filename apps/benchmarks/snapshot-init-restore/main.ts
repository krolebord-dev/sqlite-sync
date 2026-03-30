import "../src/styles.css";
import { renderSnapshotInitRestoreShell } from "./benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

renderSnapshotInitRestoreShell(rootElement);
