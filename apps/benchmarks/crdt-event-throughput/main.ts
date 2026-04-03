import "../src/styles.css";
import { renderCrdtEventThroughputShell } from "./benchmark";
import { runCrdtEventThroughputBenchmark } from "./run-benchmark";

declare global {
  interface Window {
    __sqliteSyncBenchmarks?: {
      runCrdtEventThroughputBenchmark?: typeof runCrdtEventThroughputBenchmark;
    };
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

window.__sqliteSyncBenchmarks = {
  ...window.__sqliteSyncBenchmarks,
  runCrdtEventThroughputBenchmark,
};

renderCrdtEventThroughputShell(rootElement);
