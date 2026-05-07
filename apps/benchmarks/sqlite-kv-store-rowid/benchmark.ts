/** biome-ignore-all lint/style/noNonNullAssertion: benchmark page wiring */
import { renderBenchmarksShell, renderSanitySection } from "../src/benchmarks-common";
import { type KvStoreRowIdBenchmarkResult, runSqliteKvStoreRowIdBenchmark } from "./run-benchmark";

export function renderSqliteKvStoreRowIdPage(container: HTMLElement) {
  container.innerHTML = `
    <section class="grid">
      <div class="panel">
        <h1>sqlite-kv-store rowid comparison</h1>
        <p class="muted">
          Compares the real <code>createSQLiteKvStore()</code> get/set/remove path using a regular
          <code>TEXT PRIMARY KEY</code> table versus the same table declared <code>WITHOUT ROWID</code>.
        </p>
      </div>

      <div class="panel grid grid-2">
        <label class="grid">
          <span class="muted">Seeded keys</span>
          <input class="input" data-field="key-count" type="number" min="1" step="10" value="1000" />
        </label>
        <label class="grid">
          <span class="muted">Operations per workload</span>
          <input class="input" data-field="iterations" type="number" min="1" step="1000" value="50000" />
        </label>
        <label class="grid">
          <span class="muted">Rounds</span>
          <input class="input" data-field="rounds" type="number" min="1" max="20" value="5" />
        </label>
        <div class="grid">
          <span class="muted">Benchmark status</span>
          <span data-field="db-status">loading sqlite-wasm...</span>
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
              <th>Workload</th>
              <th>Rowid mean (ms)</th>
              <th>Without rowid mean (ms)</th>
              <th>Rowid ops/sec</th>
              <th>Without rowid ops/sec</th>
              <th>Faster</th>
              <th>Delta (%)</th>
            </tr>
          </thead>
          <tbody data-field="results-body"></tbody>
        </table>
      </div>

      ${renderSanitySection([
        { field: "summary", label: "Winner summary" },
        { field: "details", label: "Sanity details" },
      ])}
    </section>
  `;

  const keyCountInput = container.querySelector<HTMLInputElement>('[data-field="key-count"]');
  const iterationsInput = container.querySelector<HTMLInputElement>('[data-field="iterations"]');
  const roundsInput = container.querySelector<HTMLInputElement>('[data-field="rounds"]');
  const statusField = container.querySelector<HTMLSpanElement>('[data-field="db-status"]');
  const runButton = container.querySelector<HTMLButtonElement>('[data-action="run"]');
  const resultsSection = container.querySelector<HTMLDivElement>('[data-section="results"]');
  const resultsBody = container.querySelector<HTMLTableSectionElement>('[data-field="results-body"]');
  const sanitySection = container.querySelector<HTMLDivElement>('[data-section="sanity"]');
  const summaryField = container.querySelector<HTMLDivElement>('[data-field="summary"]');
  const detailsField = container.querySelector<HTMLDivElement>('[data-field="details"]');

  if (
    !keyCountInput ||
    !iterationsInput ||
    !roundsInput ||
    !statusField ||
    !runButton ||
    !resultsSection ||
    !resultsBody ||
    !sanitySection ||
    !summaryField ||
    !detailsField
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
      await runSqliteKvStoreRowIdBenchmark({
        keyCount: 1,
        iterations: 1,
        rounds: 1,
        onStatus: () => {},
      });
      isReady = true;
      runButton.disabled = false;
      updateStatus("ready");
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Failed to initialize sqlite-wasm.");
      runButton.disabled = true;
    }
  };

  const renderResults = (result: KvStoreRowIdBenchmarkResult) => {
    resultsBody.innerHTML = "";
    let rowidWins = 0;
    let withoutRowidWins = 0;

    for (const row of result.rows) {
      if (row.fasterVariant === "rowid") {
        rowidWins++;
      } else {
        withoutRowidWins++;
      }

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.workload}</td>
        <td>${row.rowid.meanMs.toFixed(3)}</td>
        <td>${row.withoutRowid.meanMs.toFixed(3)}</td>
        <td>${row.rowid.throughputOpsPerSecond.toFixed(2)}</td>
        <td>${row.withoutRowid.throughputOpsPerSecond.toFixed(2)}</td>
        <td>${row.fasterVariant}</td>
        <td>${row.deltaPercent.toFixed(2)}</td>
      `;
      resultsBody.append(tr);
    }

    const winner =
      withoutRowidWins > rowidWins ? "WITHOUT ROWID wins more workloads" : "rowid-backed table wins more workloads";

    summaryField.textContent = `Winner summary: ${winner} (${rowidWins} rowid, ${withoutRowidWins} without-rowid)`;
    detailsField.textContent = `Sanity details: ${result.sanity.join(" | ")}`;
    resultsSection.hidden = false;
    sanitySection.hidden = false;
  };

  const runBenchmark = async () => {
    if (isRunning) {
      return;
    }

    const keyCount = Math.max(1, Number(keyCountInput.value) || 1);
    const iterations = Math.max(1, Number(iterationsInput.value) || 1);
    const rounds = Math.max(1, Number(roundsInput.value) || 1);

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;

    try {
      const result = await runSqliteKvStoreRowIdBenchmark({
        keyCount,
        iterations,
        rounds,
        onStatus: updateStatus,
      });
      renderResults(result);
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

export function renderSqliteKvStoreRowIdShell(container: HTMLElement) {
  renderBenchmarksShell(container, renderSqliteKvStoreRowIdPage);
}
