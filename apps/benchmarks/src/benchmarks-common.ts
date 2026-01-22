import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { applyMemoryDbSchema, type Logger, type PersistedCrdtEvent, SQLiteDbWrapper } from "@sqlite-sync/core";
import type { Bench } from "tinybench";

export type BenchRow = {
  name: string;
  hz: number;
  meanMs: number;
  rme: number;
  samples: number;
};

export const noopLogger: Logger = () => {};

export async function createBenchmarkDb<TSchema>(): Promise<SQLiteDbWrapper<TSchema>> {
  const sqlite3 = await sqlite3InitModule();
  const db = new SQLiteDbWrapper<TSchema>({
    db: new sqlite3.oo1.DB({ filename: ":memory:" }),
    sqlite3,
    logger: noopLogger,
    loggerPrefix: "benchmarks",
  });
  applyMemoryDbSchema(db);
  return db;
}

export function buildPersistedCrdtEvents(count: number): PersistedCrdtEvent[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    const itemId = `item-${id}`;
    return {
      schema_version: 1,
      status: "applied",
      sync_id: id,
      type: "item-created",
      dataset: "benchmark",
      item_id: itemId,
      payload: JSON.stringify({ id: itemId, value: id }),
      origin: "local",
      timestamp: now,
    };
  });
}

export function rowsFromTinybench(bench: Bench): BenchRow[] {
  return bench.tasks.map((task) => ({
    name: task.name,
    hz: task.result?.hz ?? 0,
    meanMs: (task.result?.mean ?? 0) * 1000,
    rme: task.result?.rme ?? 0,
    samples: task.result?.samples?.length ?? 0,
  }));
}

export function renderBenchRows(container: HTMLElement, rows: BenchRow[]) {
  container.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.hz.toFixed(2)}</td>
      <td>${row.meanMs.toFixed(3)}</td>
      <td>${row.rme.toFixed(2)}</td>
      <td>${row.samples}</td>
    `;
    container.append(tr);
  }
}

export function renderBenchmarksShell(container: HTMLElement, renderPage: (main: HTMLElement) => void) {
  container.innerHTML = "";
  const appElement = document.createElement("div");
  appElement.className = "app";

  const header = document.createElement("header");
  header.className = "app-header";
  header.innerHTML = `
    <div>
      <div class="chip">SQLite Sync Benchmarks</div>
    </div>
    <nav class="app-nav">
      <a class="chip" href="/sqlite-batch-inserts/">Batch Inserts</a>
      <a class="chip" href="/sqlite-transaction-overhead/">Transaction Overhead</a>
    </nav>
  `;

  const main = document.createElement("main");
  appElement.append(header, main);
  container.append(appElement);
  renderPage(main);
}

export function renderResultsTableSection() {
  return `
    <div class="panel" data-section="results" hidden>
      <h2>Results</h2>
      <table class="table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Ops/sec</th>
            <th>Mean (ms)</th>
            <th>RME (%)</th>
            <th>Samples</th>
          </tr>
        </thead>
        <tbody data-field="results-body"></tbody>
      </table>
    </div>
  `;
}

type SanityField = {
  field: string;
  label: string;
};

export function renderSanitySection(fields: SanityField[]) {
  const items = fields
    .map((field) => `<div class="muted" data-field="${field.field}">${field.label}: -</div>`)
    .join("");
  return `
    <div class="panel grid" data-section="sanity" hidden>
      <div><strong>Sanity checks</strong></div>
      ${items}
    </div>
  `;
}

export function clearPersistedCrdtEvents(db: SQLiteDbWrapper<any>) {
  db.execute("DELETE FROM persisted_crdt_events");
}

export function countPersistedCrdtEvents(db: SQLiteDbWrapper<any>) {
  return db.execute<{ count: number }>("select count(*) as count from persisted_crdt_events").rows[0]?.count ?? 0;
}
