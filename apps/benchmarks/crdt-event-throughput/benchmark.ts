/** biome-ignore-all lint/style/noNonNullAssertion: benchmark page wiring */
import { createDeferredPromise, type SQLiteDbWrapper } from "@sqlite-sync/core";
import {
  buildBenchmarkRows,
  buildRemoteCreateEvents,
  buildRemoteDeleteEvents,
  buildRemoteUpdateEvents,
  countEventsByStatus,
  countRows,
  createSyncBenchmarkHarness,
  insertRows,
  measureSyncSnapshotDurations,
  type SyncBenchmarkDbSchema,
} from "../src/benchmark-db";
import {
  type MeasurementRow,
  renderBenchmarksShell,
  renderSanitySection,
  summarizeDurations,
} from "../src/benchmarks-common";

type ThroughputMeasurementRow = MeasurementRow & {
  eventsPerWorkload: number;
  throughputEventsPerSecond: number;
};

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
          <input class="input" data-field="event-count" type="number" min="1" step="100" value="1000" />
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
    const seedRows = buildBenchmarkRows(eventCount);
    const baseTimestampMs = Date.now() + 60_000;

    setRunning(true);
    resultsSection.hidden = true;
    sanitySection.hidden = true;
    updateStatus("preparing snapshots...");

    const sourceHarness = await createSyncBenchmarkHarness();

    try {
      const emptySnapshot = sourceHarness.reactiveDb.createSnapshot();
      insertRows(sourceHarness.db, "benchmark", seedRows);
      const seededSnapshot = sourceHarness.reactiveDb.createSnapshot();

      const createEvents = buildRemoteCreateEvents(eventCount, { baseTimestampMs });
      const updateEvents = buildRemoteUpdateEvents(eventCount, { baseTimestampMs: baseTimestampMs + 1_000 });
      const deleteEvents = buildRemoteDeleteEvents(eventCount, { baseTimestampMs: baseTimestampMs + 2_000 });

      updateStatus("measuring workloads...");

      const createStats = summarizeDurations(
        "Remote create events",
        await measureRemoteEventDurations({
          rounds,
          snapshot: emptySnapshot,
          events: createEvents,
          expectedVisibleRows: eventCount,
        }),
      );
      const updateStats = summarizeDurations(
        "Remote update events",
        await measureRemoteEventDurations({
          rounds,
          snapshot: seededSnapshot,
          events: updateEvents,
          expectedVisibleRows: eventCount,
        }),
      );
      const deleteStats = summarizeDurations(
        "Remote delete events",
        await measureRemoteEventDurations({
          rounds,
          snapshot: seededSnapshot,
          events: deleteEvents,
          expectedVisibleRows: 0,
        }),
      );

      renderRows([
        summarizeThroughputRow(createStats, eventCount),
        summarizeThroughputRow(updateStats, eventCount),
        summarizeThroughputRow(deleteStats, eventCount),
      ]);

      const createHarness = await createSyncBenchmarkHarness({ snapshot: emptySnapshot });
      try {
        await applyRemoteEvents(createHarness, createEvents);
        createSanity.textContent = `Create sanity check: ${countRows(createHarness.db, "benchmark")} visible rows, ${countEventsByStatus(createHarness.db, "applied")} applied events`;
      } finally {
        createHarness.dispose();
      }

      const updateHarness = await createSyncBenchmarkHarness({ snapshot: seededSnapshot });
      try {
        await applyRemoteEvents(updateHarness, updateEvents);
        updateSanity.textContent = `Update sanity check: item-1 value is ${getBenchmarkValue(updateHarness.db, "item-1")}`;
      } finally {
        updateHarness.dispose();
      }

      const deleteHarness = await createSyncBenchmarkHarness({ snapshot: seededSnapshot });
      try {
        await applyRemoteEvents(deleteHarness, deleteEvents);
        deleteSanity.textContent = `Delete sanity check: ${countRows(deleteHarness.db, "benchmark")} visible rows remain`;
      } finally {
        deleteHarness.dispose();
      }

      sanitySection.hidden = false;
      updateStatus("ready");
    } finally {
      sourceHarness.dispose();
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

async function measureRemoteEventDurations({
  rounds,
  snapshot,
  events,
  expectedVisibleRows,
}: {
  rounds: number;
  snapshot: Uint8Array<ArrayBufferLike>;
  events: Parameters<Awaited<ReturnType<typeof createSyncBenchmarkHarness>>["crdtStorage"]["enqueueRemoteEvents"]>[0];
  expectedVisibleRows: number;
}) {
  return measureSyncSnapshotDurations({
    rounds,
    snapshot,
    task: async (harness) => {
      await applyRemoteEvents(harness, events);

      const visibleRows = countRows(harness.db, "benchmark");
      if (visibleRows !== expectedVisibleRows) {
        throw new Error(`Expected ${expectedVisibleRows} visible rows after workload, got ${visibleRows}.`);
      }
    },
  });
}

async function applyRemoteEvents(
  harness: Awaited<ReturnType<typeof createSyncBenchmarkHarness>>,
  events: Parameters<Awaited<ReturnType<typeof createSyncBenchmarkHarness>>["crdtStorage"]["enqueueRemoteEvents"]>[0],
) {
  const baselineApplied = countEventsByStatus(harness.db, "applied");
  const baselineFailed = countEventsByStatus(harness.db, "failed");
  const baselinePending = countEventsByStatus(harness.db, "pending");
  const completion = createDeferredPromise<void>({ timeout: 30_000 });
  const expectedAppliedCount = baselineApplied + events.length;

  const checkCompletion = () => {
    const appliedCount = countEventsByStatus(harness.db, "applied");
    const failedCount = countEventsByStatus(harness.db, "failed");
    const pendingCount = countEventsByStatus(harness.db, "pending");

    if (failedCount > baselineFailed) {
      completion.reject(new Error("At least one remote CRDT event failed to apply."));
      return;
    }

    if (pendingCount === baselinePending && appliedCount === expectedAppliedCount) {
      completion.resolve();
      return;
    }

    if (pendingCount === baselinePending && appliedCount !== expectedAppliedCount) {
      completion.reject(
        new Error(
          `Remote CRDT event workload completed with ${appliedCount - baselineApplied} applied events; expected ${events.length}.`,
        ),
      );
    }
  };

  harness.crdtStorage.addEventListener("events-applied", checkCompletion);

  try {
    harness.crdtStorage.enqueueRemoteEvents(events);
    checkCompletion();
    await completion.promise;
  } finally {
    harness.crdtStorage.removeEventListener("events-applied", checkCompletion);
  }
}

function summarizeThroughputRow(row: MeasurementRow, eventsPerWorkload: number): ThroughputMeasurementRow {
  return {
    ...row,
    eventsPerWorkload,
    throughputEventsPerSecond: eventsPerWorkload / (row.meanMs / 1_000),
  };
}

function getBenchmarkValue(db: SQLiteDbWrapper<SyncBenchmarkDbSchema>, itemId: string) {
  return db.execute<{ value: number }>({
    sql: "SELECT value FROM benchmark WHERE id = ?",
    parameters: [itemId],
  }).rows[0]?.value;
}
