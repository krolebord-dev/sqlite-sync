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
  persisted_crdt_events: PersistedCrdtEvent;
};

export function renderSqliteTransactionOverheadPage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>SQLiteDbWrapper transaction overhead</h1>
        <p class="muted">
          Compares the insert path in <code>memory-db.ts</code> with and without wrapping each insert in
          <code>executeTransaction</code> to estimate transaction wrapper overhead per event.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Number of events</span>
          <input class="input" data-field="event-count" type="number" min="1" step="100" value="10000" />
        </label>
        <div class="grid">
          <span class="muted">Database status</span>
          <span data-field="db-status">loading sqlite-wasm...</span>
        </div>
        <div class="grid">
          <span class="muted">Run benchmark</span>
          <button class="button" type="button" data-action="run" disabled>Run Tinybench</button>
        </div>
        <div class="grid">
          <span class="muted">Notes</span>
          <span class="muted">
            Tasks mirror <code>memory-db.ts</code> keys/options; compare deltas primarily to understand the cost of the
            <code>executeTransaction</code> wrapper.
          </span>
        </div>
      </div>

      ${renderResultsTableSection()}
      ${renderSanitySection([
        { field: "sanity-no-tx", label: "No transaction insert count" },
        { field: "sanity-tx", label: "Transaction-per-event insert count" },
      ])}
    </section>
  `;

  const eventCountInput = container.querySelector<HTMLInputElement>('[data-field="event-count"]');
  const statusField = container.querySelector<HTMLSpanElement>('[data-field="db-status"]');
  const runButton = container.querySelector<HTMLButtonElement>('[data-action="run"]');
  const resultsSection = container.querySelector<HTMLDivElement>('[data-section="results"]');
  const resultsBody = container.querySelector<HTMLTableSectionElement>('[data-field="results-body"]');
  const sanitySection = container.querySelector<HTMLDivElement>('[data-section="sanity"]');
  const sanityNoTx = container.querySelector<HTMLDivElement>('[data-field="sanity-no-tx"]');
  const sanityTx = container.querySelector<HTMLDivElement>('[data-field="sanity-tx"]');

  if (
    !eventCountInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !sanityNoTx ||
    !sanityTx
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

  const renderSanity = (noTxCount: number, txCount: number) => {
    sanityNoTx.textContent = `No transaction insert count: ${noTxCount} rows`;
    sanityTx.textContent = `Transaction-per-event insert count: ${txCount} rows`;
    sanitySection.hidden = false;
  };

  const runBenchmark = async () => {
    if (!db || isRunning) {
      return;
    }

    const safeEventCount = Math.max(1, Number(eventCountInput.value) || 1);
    const events = buildPersistedCrdtEvents(safeEventCount);

    // Ensure a clean slate before pre-warming prepared statements.
    clearPersistedCrdtEvents(db);

    // Pre-warm both prepared statement keys so compilation doesn't skew the comparison.
    prewarmStatements(db, events[0]!);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;

    const bench = new Bench({ time: 1_000 });

    bench.add("executePrepared (no transaction)", () => {
      clearPersistedCrdtEvents(db!);
      runNoTxInsert(db!, events);
    });

    bench.add("executeTransaction per event + executePrepared", () => {
      clearPersistedCrdtEvents(db!);
      runTxPerEventInsert(db!, events);
    });

    await bench.run();

    const rows = rowsFromTinybench(bench);

    const noTxCount = runSanityCheckNoTx(db, events);
    const txCount = runSanityCheckTxPerEvent(db, events);

    renderResults(rows);
    renderSanity(noTxCount, txCount);
    setRunning(false);
  };

  runButton.addEventListener("click", () => {
    void runBenchmark();
  });

  void initDb();
}

export function renderSqliteTransactionOverheadShell(container: HTMLElement) {
  renderBenchmarksShell(container, renderSqliteTransactionOverheadPage);
}

function prewarmStatements(db: SQLiteDbWrapper<BenchmarkDbSchema>, event: PersistedCrdtEvent) {
  // Mirrors memory-db.ts (105-121): direct executePrepared with meta.
  db.executePrepared("enqueue-crdt-event", event, insertEventFactory, { loggerLevel: "system" });
}

function runNoTxInsert(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  for (const event of events) {
    db.executePrepared("enqueue-crdt-event", event, insertEventFactory, { loggerLevel: "system" });
  }
}

function runTxPerEventInsert(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  for (const event of events) {
    db.executeTransaction((tx) => {
      tx.executePrepared("enqueue-crdt-events", event, insertEventFactory);
    });
  }
}

function runSanityCheckNoTx(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  clearPersistedCrdtEvents(db);
  runNoTxInsert(db, events);
  return countPersistedCrdtEvents(db);
}

function runSanityCheckTxPerEvent(db: SQLiteDbWrapper<BenchmarkDbSchema>, events: PersistedCrdtEvent[]) {
  clearPersistedCrdtEvents(db);
  runTxPerEventInsert(db, events);
  return countPersistedCrdtEvents(db);
}

function insertEventFactory(
  db: Kysely<BenchmarkDbSchema>,
  params: <TKey extends keyof PersistedCrdtEvent>(key: TKey) => any,
) {
  return db.insertInto("persisted_crdt_events").values({
    schema_version: params("schema_version"),
    status: params("status"),
    sync_id: params("sync_id"),
    type: params("type"),
    timestamp: params("timestamp"),
    dataset: params("dataset"),
    item_id: params("item_id"),
    payload: params("payload"),
    origin: params("origin"),
    source_node_id: params("source_node_id"),
  });
}
