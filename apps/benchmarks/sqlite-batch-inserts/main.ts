import "../src/styles.css";
import { renderSqliteBatchInsertShell } from "./benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

renderSqliteBatchInsertShell(rootElement);
