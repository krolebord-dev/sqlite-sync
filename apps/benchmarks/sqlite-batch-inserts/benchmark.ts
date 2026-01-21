import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import {
  SQLiteDbWrapper,
  applyMemoryDbSchema,
  type Logger,
  type PersistedCrdtEvent,
} from "@sqlite-sync/core";
import type { Kysely } from "kysely";
import { Bench } from "tinybench";

type BenchmarkDbSchema = {
  crdt_update_log: {
    dataset: string;
    item_id: string;
    payload: string;
  };
  persisted_crdt_events: PersistedCrdtEvent;
};

type BenchRow = {
  name: string;
  hz: number;
  meanMs: number;
  rme: number;
  samples: number;
};

const noopLogger: Logger = () => {};

export function renderSqliteBatchInsertPage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>SQLiteDbWrapper batch inserts</h1>
        <p class="muted">
          Compares two insert strategies from memory-db.ts: chunked multi-row inserts vs per-row prepared statements,
          each wrapped in a single transaction.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Number of events</span>
          <input class="input" data-field="event-count" type="number" min="1" step="100" value="1000" />
        </label>
        <label class="grid">
          <span class="muted">Chunk size (strategy A)</span>
          <input class="input" data-field="chunk-size" type="number" min="1" value="100" />
        </label>
        <div class="grid">
          <span class="muted">Database status</span>
          <span data-field="db-status">loading sqlite-wasm...</span>
        </div>
        <div class="grid">
          <span class="muted">Run benchmark</span>
          <button class="button" type="button" data-action="run" disabled>Run Tinybench</button>
        </div>
      </div>

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

      <div class="panel grid" data-section="sanity" hidden>
        <div><strong>Sanity checks</strong></div>
        <div class="muted" data-field="sanity-chunked">Chunked insert count: -</div>
        <div class="muted" data-field="sanity-prepared">Prepared insert count: -</div>
      </div>
    </section>
  `;

  const eventCountInput = container.querySelector<HTMLInputElement>('[data-field="event-count"]');
  const chunkSizeInput = container.querySelector<HTMLInputElement>('[data-field="chunk-size"]');
  const statusField = container.querySelector<HTMLSpanElement>('[data-field="db-status"]');
  const runButton = container.querySelector<HTMLButtonElement>('[data-action="run"]');
  const resultsSection = container.querySelector<HTMLDivElement>('[data-section="results"]');
  const resultsBody = container.querySelector<HTMLTableSectionElement>('[data-field="results-body"]');
  const sanitySection = container.querySelector<HTMLDivElement>('[data-section="sanity"]');
  const sanityChunked = container.querySelector<HTMLDivElement>('[data-field="sanity-chunked"]');
  const sanityPrepared = container.querySelector<HTMLDivElement>('[data-field="sanity-prepared"]');

  if (
    !eventCountInput ||
    !chunkSizeInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !sanityChunked ||
    !sanityPrepared
  ) {
    throw new Error("Benchmark UI failed to initialize.");
  }

  let db: SQLiteDbWrapper<BenchmarkDbSchema> | null = null;
  let isRunning = false;

  const updateStatus = (text: string) => {
    statusField.textContent = text;
  };

  const setRunning = (running: boolean) => {
    isRunning = running;
    runButton.disabled = running || !db;
    runButton.textContent = running ? "Running..." : "Run Tinybench";
  };

  const initDb = async () => {
    try {
      const sqlite3 = await sqlite3InitModule();
      db = new SQLiteDbWrapper<BenchmarkDbSchema>({
        db: new sqlite3.oo1.DB({ filename: ":memory:" }),
        sqlite3,
        logger: noopLogger,
        loggerPrefix: "benchmarks",
      });
      applyMemoryDbSchema(db);
      updateStatus("ready");
      runButton.disabled = false;
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Failed to initialize sqlite-wasm.");
      runButton.disabled = true;
    }
  };

  const renderResults = (rows: BenchRow[]) => {
    resultsBody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.name}</td>
        <td>${row.hz.toFixed(2)}</td>
        <td>${row.meanMs.toFixed(3)}</td>
        <td>${row.rme.toFixed(2)}</td>
        <td>${row.samples}</td>
      `;
      resultsBody.append(tr);
    }
    resultsSection.hidden = false;
  };

  const renderSanity = (chunkedCount: number, preparedCount: number) => {
    sanityChunked.textContent = `Chunked insert count: ${chunkedCount} rows`;
    sanityPrepared.textContent = `Prepared insert count: ${preparedCount} rows`;
    sanitySection.hidden = false;
  };

  const runBenchmark = async () => {
    if (!db || isRunning) {
      return;
    }

    const safeEventCount = Math.max(1, Number(eventCountInput.value) || 1);
    const safeChunkSize = Math.max(1, Number(chunkSizeInput.value) || 1);
    const events = buildEvents(safeEventCount);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;

    const bench = new Bench({ time: 1_000 });

    bench.add("Chunked inserts in transaction", () => {
      resetTable(db);
      runChunkedInsert(db, events, safeChunkSize);
    });

    bench.add("Prepared inserts in transaction", () => {
      resetTable(db);
      runPreparedInsert(db, events);
    });

    await bench.run();

    const rows: BenchRow[] = bench.tasks.map((task) => ({
      name: task.name,
      hz: task.result?.hz ?? 0,
      meanMs: (task.result?.mean ?? 0) * 1000,
      rme: task.result?.rme ?? 0,
      samples: task.result?.samples?.length ?? 0,
    }));

    const chunkedCount = runSanityCheckChunked(db, events, safeChunkSize);
    const preparedCount = runSanityCheckPrepared(db, events);

    renderResults(rows);
    renderSanity(chunkedCount, preparedCount);
    setRunning(false);
  };

  runButton.addEventListener("click", () => {
    void runBenchmark();
  });

  void initDb();
}

export function renderSqliteBatchInsertShell(container: HTMLElement) {
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
    </nav>
  `;

  const main = document.createElement("main");
  appElement.append(header, main);
  container.append(appElement);
  renderSqliteBatchInsertPage(main);
}

function buildEvents(count: number): PersistedCrdtEvent[] {
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
      origin: "benchmark",
      timestamp: now,
    };
  });
}

function resetTable(db: SQLiteDbWrapper<BenchmarkDbSchema>) {
  db.execute("DELETE FROM persisted_crdt_events");
}

function runChunkedInsert(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[], chunkSize: number) {
  db.executeTransaction((tx) => {
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      tx.executeKysely((kysely) => kysely.insertInto("persisted_crdt_events").values(chunk));
    }
  });
}

function runPreparedInsert(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  db.executeTransaction((tx) => {
    for (const event of events) {
      tx.executePrepared("enqueue-crdt-events", event, (kysely, params) =>
        (kysely as unknown as Kysely<BenchmarkDbSchema>).insertInto("persisted_crdt_events").values({
          schema_version: params("schema_version"),
          status: params("status"),
          sync_id: params("sync_id"),
          type: params("type"),
          dataset: params("dataset"),
          item_id: params("item_id"),
          payload: params("payload"),
          origin: params("origin"),
          timestamp: params("timestamp"),
        }),
      );
    }
  });
}

function runSanityCheckChunked(
  db: SQLiteDbWrapper<BenchmarkDbSchema>,
  events: PersistedCrdtEvent[],
  chunkSize: number,
) {
  resetTable(db);
  runChunkedInsert(db, events, chunkSize);
  return db.execute<{ count: number }>("select count(*) as count from persisted_crdt_events").rows[0]?.count ?? 0;
}

function runSanityCheckPrepared(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  resetTable(db);
  runPreparedInsert(db, events);
  return db.execute<{ count: number }>("select count(*) as count from persisted_crdt_events").rows[0]?.count ?? 0;
}
