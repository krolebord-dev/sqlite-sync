/** biome-ignore-all lint/style/noNonNullAssertion: benchmark page wiring */
import { SQLiteReactiveDb } from "@sqlite-sync/core";
import {
  buildBenchmarkRows,
  countEvents,
  countRows,
  createSyncBenchmarkHarness,
  insertRows,
} from "../src/benchmark-db";
import {
  measureDurations,
  noopLogger,
  renderBenchmarksShell,
  renderMeasurementRows,
  renderMeasurementsTableSection,
  renderSanitySection,
  summarizeDurations,
} from "../src/benchmarks-common";

export function renderSnapshotInitRestorePage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>Snapshot initialization and restore</h1>
        <p class="muted">
          Measures snapshot export, fresh in-memory startup from a snapshot, and restore on an existing connection.
          The populated database uses the sqlite-sync benchmark schema and event journal.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Rows in populated snapshot</span>
          <input class="input" data-field="row-count" type="number" min="1" step="1000" value="10000" />
        </label>
        <label class="grid">
          <span class="muted">Rounds</span>
          <input class="input" data-field="rounds" type="number" min="1" max="20" value="5" />
        </label>
        <div class="grid">
          <span class="muted">Benchmark status</span>
          <span data-field="db-status">initializing benchmark database...</span>
        </div>
        <div class="grid">
          <span class="muted">Run benchmark</span>
          <button class="button" type="button" data-action="run" disabled>Run measurements</button>
        </div>
      </div>

      ${renderMeasurementsTableSection()}
      ${renderSanitySection([
        { field: "snapshot-size", label: "Snapshot size" },
        { field: "restored-rows", label: "Rows after restore sanity check" },
        { field: "restored-events", label: "Events after restore sanity check" },
      ])}
    </section>
  `;

  const rowCountInput = container.querySelector<HTMLInputElement>('[data-field="row-count"]');
  const roundsInput = container.querySelector<HTMLInputElement>('[data-field="rounds"]');
  const statusField = container.querySelector<HTMLSpanElement>('[data-field="db-status"]');
  const runButton = container.querySelector<HTMLButtonElement>('[data-action="run"]');
  const resultsSection = container.querySelector<HTMLDivElement>('[data-section="results"]');
  const resultsBody = container.querySelector<HTMLTableSectionElement>('[data-field="results-body"]');
  const sanitySection = container.querySelector<HTMLDivElement>('[data-section="sanity"]');
  const snapshotSizeField = container.querySelector<HTMLDivElement>('[data-field="snapshot-size"]');
  const restoredRowsField = container.querySelector<HTMLDivElement>('[data-field="restored-rows"]');
  const restoredEventsField = container.querySelector<HTMLDivElement>('[data-field="restored-events"]');

  if (
    !rowCountInput ||
    !roundsInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !snapshotSizeField ||
    !restoredRowsField ||
    !restoredEventsField
  ) {
    throw new Error("Benchmark UI failed to initialize.");
  }

  let isReady = false;
  let isRunning = false;

  const updateStatus = (text: string) => {
    statusField.textContent = text;
  };

  const setRunning = (running: boolean) => {
    isRunning = running;
    runButton.disabled = running || !isReady;
    runButton.textContent = running ? "Running..." : "Run measurements";
  };

  const init = async () => {
    try {
      const harness = await createSyncBenchmarkHarness();
      harness.dispose();
      isReady = true;
      runButton.disabled = false;
      updateStatus("ready");
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Failed to initialize benchmark database.");
      runButton.disabled = true;
    }
  };

  const runBenchmark = async () => {
    if (isRunning) {
      return;
    }

    const rowCount = Math.max(1, Number(rowCountInput.value) || 1);
    const rounds = Math.max(1, Number(roundsInput.value) || 1);
    const rows = buildBenchmarkRows(rowCount);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;
    updateStatus("building populated snapshot...");

    const sourceHarness = await createSyncBenchmarkHarness();
    const restoreDb = await SQLiteReactiveDb.create({
      snapshot: new Uint8Array(),
      logger: noopLogger,
    });

    try {
      insertRows(sourceHarness.db, "benchmark", rows);
      const populatedSnapshot = sourceHarness.reactiveDb.createSnapshot();

      updateStatus("measuring snapshot workflows...");

      const measurements = [
        summarizeDurations(
          "Snapshot export",
          await measureDurations({
            rounds,
            task: () => {
              void sourceHarness.reactiveDb.createSnapshot();
            },
          }),
        ),
        summarizeDurations(
          "Fresh SQLiteReactiveDb.create({ snapshot })",
          await measureDurations({
            rounds,
            task: async () => {
              const reactiveDb = await SQLiteReactiveDb.create({
                snapshot: populatedSnapshot,
                logger: noopLogger,
              });
              reactiveDb.dispose();
            },
          }),
        ),
        summarizeDurations(
          "Existing connection useSnapshot(snapshot)",
          await measureDurations({
            rounds,
            task: () => {
              restoreDb.useSnapshot(populatedSnapshot);
            },
          }),
        ),
      ];

      restoreDb.useSnapshot(populatedSnapshot);

      renderMeasurementRows(resultsBody, measurements);
      snapshotSizeField.textContent = `Snapshot size: ${(populatedSnapshot.byteLength / 1024).toFixed(1)} KB`;
      restoredRowsField.textContent = `Rows after restore sanity check: ${countRows(restoreDb.db, "benchmark")}`;
      restoredEventsField.textContent = `Events after restore sanity check: ${countEvents(restoreDb.db)}`;
      resultsSection.hidden = false;
      sanitySection.hidden = false;
      updateStatus("ready");
    } finally {
      restoreDb.dispose();
      sourceHarness.dispose();
      setRunning(false);
    }
  };

  runButton.addEventListener("click", () => {
    void runBenchmark();
  });

  void init();
}

export function renderSnapshotInitRestoreShell(container: HTMLElement) {
  renderBenchmarksShell(container, renderSnapshotInitRestorePage);
}
