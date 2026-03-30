/** biome-ignore-all lint/style/noNonNullAssertion: benchmark page wiring */
import {
  buildBenchmarkRows,
  countEvents,
  createSyncBenchmarkHarness,
  deleteRows,
  insertRows,
  measureSyncSnapshotDurations,
  updateRows,
} from "../src/benchmark-db";
import { renderBenchmarksShell, renderSanitySection, summarizeDurations } from "../src/benchmarks-common";

type ScaleResult = {
  eventCount: number;
  insertMeanMs: number;
  updateMeanMs: number;
  deleteMeanMs: number;
  rounds: number;
  journalCount: number;
};

const EVENT_SCALES = [100, 1_000, 10_000, 100_000];

export function renderEventScalePage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>Event log scalability</h1>
        <p class="muted">
          Measures how sqlite-sync local write workloads behave when the event journal already contains
          100, 1 000, 10 000 and 100 000 events. For each scale, the benchmark restores the same populated snapshot
          before every round.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Operations per workload</span>
          <input class="input" data-field="workload-count" type="number" min="1" step="10" value="100" />
        </label>
        <label class="grid">
          <span class="muted">Rounds per scale</span>
          <input class="input" data-field="rounds" type="number" min="1" max="10" value="3" />
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

      <div class="panel" data-section="results" hidden>
        <h2>Results</h2>
        <table class="table">
          <thead>
            <tr>
              <th>Existing events</th>
              <th>Insert mean (ms)</th>
              <th>Update mean (ms)</th>
              <th>Delete mean (ms)</th>
              <th>Rounds</th>
              <th>Journal rows</th>
            </tr>
          </thead>
          <tbody data-field="results-body"></tbody>
        </table>
      </div>

      ${renderSanitySection([
        { field: "scales", label: "Measured scales" },
        { field: "workload-size", label: "Operations per workload" },
      ])}
    </section>
  `;

  const workloadCountInput = container.querySelector<HTMLInputElement>('[data-field="workload-count"]');
  const roundsInput = container.querySelector<HTMLInputElement>('[data-field="rounds"]');
  const statusField = container.querySelector<HTMLSpanElement>('[data-field="db-status"]');
  const runButton = container.querySelector<HTMLButtonElement>('[data-action="run"]');
  const resultsSection = container.querySelector<HTMLDivElement>('[data-section="results"]');
  const resultsBody = container.querySelector<HTMLTableSectionElement>('[data-field="results-body"]');
  const sanitySection = container.querySelector<HTMLDivElement>('[data-section="sanity"]');
  const scalesField = container.querySelector<HTMLDivElement>('[data-field="scales"]');
  const workloadSizeField = container.querySelector<HTMLDivElement>('[data-field="workload-size"]');

  if (
    !workloadCountInput ||
    !roundsInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !scalesField ||
    !workloadSizeField
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

  const renderRows = (rows: ScaleResult[]) => {
    resultsBody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.eventCount.toLocaleString()}</td>
        <td>${row.insertMeanMs.toFixed(3)}</td>
        <td>${row.updateMeanMs.toFixed(3)}</td>
        <td>${row.deleteMeanMs.toFixed(3)}</td>
        <td>${row.rounds}</td>
        <td>${row.journalCount.toLocaleString()}</td>
      `;
      resultsBody.append(tr);
    }
  };

  const runBenchmark = async () => {
    if (isRunning) {
      return;
    }

    const workloadCount = Math.max(1, Number(workloadCountInput.value) || 1);
    const rounds = Math.max(1, Number(roundsInput.value) || 1);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;

    const results: ScaleResult[] = [];

    try {
      for (const eventCount of EVENT_SCALES) {
        updateStatus(`preparing scale ${eventCount.toLocaleString()}...`);
        const harness = await createSyncBenchmarkHarness();

        try {
          insertRows(harness.db, "benchmark", buildBenchmarkRows(eventCount), {
            chunkSize: 250,
          });
          const baselineSnapshot = harness.reactiveDb.createSnapshot();
          const insertPayload = buildBenchmarkRows(workloadCount, eventCount);
          const mutableRows = Math.min(workloadCount, eventCount);

          updateStatus(`measuring scale ${eventCount.toLocaleString()}...`);

          const insertStats = summarizeDurations(
            `insert-${eventCount}`,
            await measureSyncSnapshotDurations({
              rounds,
              snapshot: baselineSnapshot,
              task: (roundHarness) => {
                insertRows(roundHarness.db, "benchmark", insertPayload, {
                  chunkSize: 250,
                });
              },
            }),
          );
          const updateStats = summarizeDurations(
            `update-${eventCount}`,
            await measureSyncSnapshotDurations({
              rounds,
              snapshot: baselineSnapshot,
              task: (roundHarness) => {
                updateRows(roundHarness.db, "benchmark", mutableRows, 1_000_000);
              },
            }),
          );
          const deleteStats = summarizeDurations(
            `delete-${eventCount}`,
            await measureSyncSnapshotDurations({
              rounds,
              snapshot: baselineSnapshot,
              task: (roundHarness) => {
                deleteRows(roundHarness.db, "benchmark", mutableRows);
              },
            }),
          );

          results.push({
            eventCount,
            insertMeanMs: insertStats.meanMs,
            updateMeanMs: updateStats.meanMs,
            deleteMeanMs: deleteStats.meanMs,
            rounds,
            journalCount: countEvents(harness.db),
          });
        } finally {
          harness.dispose();
        }
      }

      renderRows(results);
      scalesField.textContent = `Measured scales: ${EVENT_SCALES.map((scale) => scale.toLocaleString()).join(", ")}`;
      workloadSizeField.textContent = `Operations per workload: ${workloadCount}`;
      resultsSection.hidden = false;
      sanitySection.hidden = false;
      updateStatus("ready");
    } finally {
      setRunning(false);
    }
  };

  runButton.addEventListener("click", () => {
    void runBenchmark();
  });

  void init();
}

export function renderEventScaleShell(container: HTMLElement) {
  renderBenchmarksShell(container, renderEventScalePage);
}
