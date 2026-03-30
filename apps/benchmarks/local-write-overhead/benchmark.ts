/** biome-ignore-all lint/style/noNonNullAssertion: benchmark page wiring */
import {
  buildBenchmarkRows,
  countEvents,
  countRows,
  createPlainBenchmarkTable,
  createSyncBenchmarkHarness,
  deleteRows,
  insertRows,
  measureSyncSnapshotDurations,
  updateRows,
} from "../src/benchmark-db";
import {
  measureDurations,
  renderBenchmarksShell,
  renderMeasurementRows,
  renderMeasurementsTableSection,
  renderSanitySection,
  summarizeDurations,
} from "../src/benchmarks-common";

export function renderLocalWriteOverheadPage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>Local write overhead: plain SQLite vs sqlite-sync</h1>
        <p class="muted">
          Measures insert, update and delete workloads in a plain SQLite table and in a CRDT view backed by
          sqlite-sync. The benchmark restores an identical snapshot before each round, and the measured interval starts
          only after the restore step.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Rows per workload</span>
          <input class="input" data-field="row-count" type="number" min="1" step="100" value="1000" />
        </label>
        <label class="grid">
          <span class="muted">Rounds</span>
          <input class="input" data-field="rounds" type="number" min="1" max="20" value="5" />
        </label>
        <div class="grid">
          <span class="muted">Benchmark status</span>
          <span data-field="db-status">initializing databases...</span>
        </div>
        <div class="grid">
          <span class="muted">Run benchmark</span>
          <button class="button" type="button" data-action="run" disabled>Run measurements</button>
        </div>
      </div>

      ${renderMeasurementsTableSection()}
      ${renderSanitySection([
        { field: "plain-sanity", label: "Plain table rows after insert sanity check" },
        { field: "sync-sanity", label: "sqlite-sync rows after insert sanity check" },
        { field: "sync-events", label: "sqlite-sync events after insert sanity check" },
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
  const plainSanity = container.querySelector<HTMLDivElement>('[data-field="plain-sanity"]');
  const syncSanity = container.querySelector<HTMLDivElement>('[data-field="sync-sanity"]');
  const syncEvents = container.querySelector<HTMLDivElement>('[data-field="sync-events"]');

  if (
    !rowCountInput ||
    !roundsInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !plainSanity ||
    !syncSanity ||
    !syncEvents
  ) {
    throw new Error("Benchmark UI failed to initialize.");
  }

  let isRunning = false;
  let isReady = false;

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
      await Promise.all([
        createPlainBenchmarkTable().then((db) => db.close()),
        createSyncBenchmarkHarness().then((db) => db.dispose()),
      ]);
      isReady = true;
      runButton.disabled = false;
      updateStatus("ready");
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Failed to initialize benchmark databases.");
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
    updateStatus("preparing snapshots...");

    const plainDb = await createPlainBenchmarkTable();
    const sourceSyncHarness = await createSyncBenchmarkHarness();

    try {
      const emptyPlainSnapshot = plainDb.createSnapshot();
      insertRows(plainDb, "benchmark_plain", rows);
      const seededPlainSnapshot = plainDb.createSnapshot();

      const emptySyncSnapshot = sourceSyncHarness.reactiveDb.createSnapshot();
      insertRows(sourceSyncHarness.db, "benchmark", rows);
      const seededSyncSnapshot = sourceSyncHarness.reactiveDb.createSnapshot();

      updateStatus("measuring workloads...");

      const measurements = [
        summarizeDurations(
          "Plain SQLite insert",
          await measureDurations({
            rounds,
            task: () => {
              plainDb.useSnapshot(emptyPlainSnapshot);
              insertRows(plainDb, "benchmark_plain", rows);
            },
          }),
        ),
        summarizeDurations(
          "sqlite-sync insert",
          await measureSyncSnapshotDurations({
            rounds,
            snapshot: emptySyncSnapshot,
            task: (harness) => {
              insertRows(harness.db, "benchmark", rows);
            },
          }),
        ),
        summarizeDurations(
          "Plain SQLite update",
          await measureDurations({
            rounds,
            task: () => {
              plainDb.useSnapshot(seededPlainSnapshot);
              updateRows(plainDb, "benchmark_plain", rowCount);
            },
          }),
        ),
        summarizeDurations(
          "sqlite-sync update",
          await measureSyncSnapshotDurations({
            rounds,
            snapshot: seededSyncSnapshot,
            task: (harness) => {
              updateRows(harness.db, "benchmark", rowCount);
            },
          }),
        ),
        summarizeDurations(
          "Plain SQLite delete",
          await measureDurations({
            rounds,
            task: () => {
              plainDb.useSnapshot(seededPlainSnapshot);
              deleteRows(plainDb, "benchmark_plain", rowCount);
            },
          }),
        ),
        summarizeDurations(
          "sqlite-sync delete",
          await measureSyncSnapshotDurations({
            rounds,
            snapshot: seededSyncSnapshot,
            task: (harness) => {
              deleteRows(harness.db, "benchmark", rowCount);
            },
          }),
        ),
      ];

      plainDb.useSnapshot(emptyPlainSnapshot);
      insertRows(plainDb, "benchmark_plain", rows);

      const syncSanityHarness = await createSyncBenchmarkHarness({
        snapshot: emptySyncSnapshot,
      });

      try {
        insertRows(syncSanityHarness.db, "benchmark", rows);

        renderMeasurementRows(resultsBody, measurements);
        plainSanity.textContent = `Plain table rows after insert sanity check: ${countRows(plainDb, "benchmark_plain")}`;
        syncSanity.textContent = `sqlite-sync rows after insert sanity check: ${countRows(syncSanityHarness.db, "benchmark")}`;
        syncEvents.textContent = `sqlite-sync events after insert sanity check: ${countEvents(syncSanityHarness.db)}`;
      } finally {
        syncSanityHarness.dispose();
      }

      resultsSection.hidden = false;
      sanitySection.hidden = false;
      updateStatus("ready");
    } finally {
      plainDb.close();
      sourceSyncHarness.dispose();
      setRunning(false);
    }
  };

  runButton.addEventListener("click", () => {
    void runBenchmark();
  });

  void init();
}

export function renderLocalWriteOverheadShell(container: HTMLElement) {
  renderBenchmarksShell(container, renderLocalWriteOverheadPage);
}
