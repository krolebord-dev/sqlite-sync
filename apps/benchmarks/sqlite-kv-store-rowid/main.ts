import "../src/styles.css";
import { renderSqliteKvStoreRowIdShell } from "./benchmark";
import { runSqliteKvStoreRowIdBenchmark } from "./run-benchmark";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

const benchmarkWindow = window as typeof window & {
  __sqliteSyncBenchmarks?: Record<string, unknown>;
};

benchmarkWindow.__sqliteSyncBenchmarks = {
  ...benchmarkWindow.__sqliteSyncBenchmarks,
  runSqliteKvStoreRowIdBenchmark,
};

renderSqliteKvStoreRowIdShell(rootElement);
