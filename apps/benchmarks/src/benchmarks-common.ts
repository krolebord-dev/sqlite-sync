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

export type MeasurementRow = {
  name: string;
  meanMs: number;
  minMs: number;
  maxMs: number;
  rounds: number;
};

export const noopLogger: Logger = () => {};

export async function createBenchmarkDb<TSchema>(): Promise<SQLiteDbWrapper<TSchema>> {
  const sqlite3 = await sqlite3InitModule();
  const db = new SQLiteDbWrapper<TSchema>({
    db: () => new sqlite3.oo1.DB({ filename: ":memory:" }),
    sqlite3,
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
      source_node_id: "",
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
      <a class="chip" href="/sqlite-kv-store-rowid/">KV Store Rowid</a>
      <a class="chip" href="/sqlite-batch-inserts/">Batch Inserts</a>
      <a class="chip" href="/sqlite-transaction-overhead/">Transaction Overhead</a>
      <a class="chip" href="/local-write-overhead/">Local Writes</a>
      <a class="chip" href="/crdt-event-throughput/">CRDT Event Throughput</a>
      <a class="chip" href="/snapshot-init-restore/">Snapshot Init</a>
      <a class="chip" href="/event-scale/">Event Scale</a>
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

export function renderMeasurementsTableSection() {
  return `
    <div class="panel" data-section="results" hidden>
      <h2>Results</h2>
      <table class="table">
        <thead>
          <tr>
            <th>Task</th>
            <th>Mean (ms)</th>
            <th>Min (ms)</th>
            <th>Max (ms)</th>
            <th>Rounds</th>
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

export async function measureDurations({
  rounds,
  task,
}: {
  rounds: number;
  task: (round: number) => void | Promise<void>;
}) {
  const durations: number[] = [];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    await task(round);
    durations.push(performance.now() - start);
    await Promise.resolve();
  }
  return durations;
}

export function summarizeDurations(name: string, durations: number[]): MeasurementRow {
  if (durations.length === 0) {
    throw new Error(`Cannot summarize measurement "${name}" without any durations.`);
  }

  const meanMs = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const minMs = Math.min(...durations);
  const maxMs = Math.max(...durations);

  return {
    name,
    meanMs,
    minMs,
    maxMs,
    rounds: durations.length,
  };
}

export function renderMeasurementRows(container: HTMLElement, rows: MeasurementRow[]) {
  container.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.name}</td>
      <td>${row.meanMs.toFixed(3)}</td>
      <td>${row.minMs.toFixed(3)}</td>
      <td>${row.maxMs.toFixed(3)}</td>
      <td>${row.rounds}</td>
    `;
    container.append(tr);
  }
}
