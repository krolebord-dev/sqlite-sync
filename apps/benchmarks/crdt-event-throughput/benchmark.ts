/** biome-ignore-all lint/style/noNonNullAssertion: benchmark page wiring */
import { createSyncBenchmarkHarness } from "../src/benchmark-db";
import { renderBenchmarksShell, renderSanitySection } from "../src/benchmarks-common";
import { runCrdtEventThroughputBenchmark, type ThroughputMeasurementRow } from "./run-benchmark";

export function renderCrdtEventThroughputPage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>CRDT event throughput</h1>
        <p class="muted">
          Measures how many remote CRDT events sqlite-sync can persist and apply per second. Each round restores an
          identical snapshot before timing starts, then enqueues a batch of synthetic remote create, update or delete
          events through the CRDT storage pipeline.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Events per workload</span>
          <input class="input" data-field="event-count" type="number" min="1" step="100" value="20000" />
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

      <div class="panel" data-section="results" hidden>
        <h2>Results</h2>
        <table class="table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Events / workload</th>
              <th>Throughput (events/sec)</th>
              <th>Mean (ms)</th>
              <th>Min (ms)</th>
              <th>Max (ms)</th>
              <th>Rounds</th>
            </tr>
          </thead>
          <tbody data-field="results-body"></tbody>
        </table>
      </div>

      ${renderSanitySection([
        { field: "create-sanity", label: "Create sanity check" },
        { field: "update-sanity", label: "Update sanity check" },
        { field: "delete-sanity", label: "Delete sanity check" },
      ])}
    </section>
  `;

  const eventCountInput = container.querySelector<HTMLInputElement>('[data-field="event-count"]');
  const roundsInput = container.querySelector<HTMLInputElement>('[data-field="rounds"]');
  const statusField = container.querySelector<HTMLSpanElement>('[data-field="db-status"]');
  const runButton = container.querySelector<HTMLButtonElement>('[data-action="run"]');
  const resultsSection = container.querySelector<HTMLDivElement>('[data-section="results"]');
  const resultsBody = container.querySelector<HTMLTableSectionElement>('[data-field="results-body"]');
  const sanitySection = container.querySelector<HTMLDivElement>('[data-section="sanity"]');
  const createSanity = container.querySelector<HTMLDivElement>('[data-field="create-sanity"]');
  const updateSanity = container.querySelector<HTMLDivElement>('[data-field="update-sanity"]');
  const deleteSanity = container.querySelector<HTMLDivElement>('[data-field="delete-sanity"]');

  if (
    !eventCountInput ||
    !roundsInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !createSanity ||
    !updateSanity ||
    !deleteSanity
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

  const renderRows = (rows: ThroughputMeasurementRow[]) => {
    resultsBody.innerHTML = "";
    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.name}</td>
        <td>${row.eventsPerWorkload.toLocaleString()}</td>
        <td>${row.throughputEventsPerSecond.toFixed(2)}</td>
        <td>${row.meanMs.toFixed(3)}</td>
        <td>${row.minMs.toFixed(3)}</td>
        <td>${row.maxMs.toFixed(3)}</td>
        <td>${row.rounds}</td>
      `;
      resultsBody.append(tr);
    }
    resultsSection.hidden = false;
  };

  const runBenchmark = async () => {
    if (isRunning) {
      return;
    }

    const eventCount = Math.max(1, Number(eventCountInput.value) || 1);
    const rounds = Math.max(1, Number(roundsInput.value) || 1);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;

    try {
      const result = await runCrdtEventThroughputBenchmark({
        eventCount,
        rounds,
        onStatus: updateStatus,
      });

      renderRows(result.rows);
      createSanity.textContent = result.sanity.create;
      updateSanity.textContent = result.sanity.update;
      deleteSanity.textContent = result.sanity.delete;
      sanitySection.hidden = false;
      updateStatus("ready");
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Benchmark failed.");
    } finally {
      setRunning(false);
    }
  };

  runButton.addEventListener("click", () => {
    void runBenchmark();
  });

  void init();
}

export function renderCrdtEventThroughputShell(container: HTMLElement) {
  renderBenchmarksShell(container, renderCrdtEventThroughputPage);
}
