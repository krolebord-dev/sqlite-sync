import "../src/styles.css";
import { renderSqliteTransactionOverheadShell } from "./benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

renderSqliteTransactionOverheadShell(rootElement);

