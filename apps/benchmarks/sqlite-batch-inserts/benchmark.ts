/** biome-ignore-all lint/style/noNonNullAssertion: this is a benchmark */
import type { PersistedCrdtEvent, SQLiteDbWrapper } from "@sqlite-sync/core";
import type { Kysely } from "kysely";
import { Bench } from "tinybench";
import {
  type BenchRow,
  buildPersistedCrdtEvents,
  clearPersistedCrdtEvents,
  countPersistedCrdtEvents,
  createBenchmarkDb,
  renderBenchmarksShell,
  renderBenchRows,
  renderResultsTableSection,
  renderSanitySection,
  rowsFromTinybench,
} from "../src/benchmarks-common";

type BenchmarkDbSchema = {
  crdt_update_log: {
    dataset: string;
    item_id: string;
    payload: string;
  };
  persisted_crdt_events: PersistedCrdtEvent;
};

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

      ${renderResultsTableSection()}
      ${renderSanitySection([
        { field: "sanity-chunked", label: "Chunked insert count" },
        { field: "sanity-prepared", label: "Prepared insert count" },
      ])}
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
      db = await createBenchmarkDb<BenchmarkDbSchema>();
      updateStatus("ready");
      runButton.disabled = false;
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Failed to initialize sqlite-wasm.");
      runButton.disabled = true;
    }
  };

  const renderResults = (rows: BenchRow[]) => {
    renderBenchRows(resultsBody, rows);
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
    const events = buildPersistedCrdtEvents(safeEventCount);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;

    const bench = new Bench({ time: 1_000 });

    bench.add("Chunked inserts in transaction", () => {
      clearPersistedCrdtEvents(db!);
      runChunkedInsert(db!, events, safeChunkSize);
    });

    bench.add("Prepared inserts in transaction", () => {
      clearPersistedCrdtEvents(db!);
      runPreparedInsert(db!, events);
    });

    await bench.run();

    const rows = rowsFromTinybench(bench);

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
  renderBenchmarksShell(container, renderSqliteBatchInsertPage);
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
          source_node_id: params("source_node_id"),
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
  clearPersistedCrdtEvents(db);
  runChunkedInsert(db, events, chunkSize);
  return countPersistedCrdtEvents(db);
}

function runSanityCheckPrepared(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  clearPersistedCrdtEvents(db);
  runPreparedInsert(db, events);
  return countPersistedCrdtEvents(db);
}
