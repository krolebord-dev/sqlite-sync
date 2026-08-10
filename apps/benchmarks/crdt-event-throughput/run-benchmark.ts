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
import { type MeasurementRow, summarizeDurations } from "../src/benchmarks-common";

export type ThroughputMeasurementRow = MeasurementRow & {
  eventsPerWorkload: number;
  throughputEventsPerSecond: number;
};

export type CrdtEventThroughputBenchmarkResult = {
  eventCount: number;
  rounds: number;
  rows: ThroughputMeasurementRow[];
  sanity: {
    create: string;
    update: string;
    delete: string;
  };
};

export async function runCrdtEventThroughputBenchmark({
  eventCount,
  rounds,
  onStatus,
}: {
  eventCount: number;
  rounds: number;
  onStatus?: (status: string) => void;
}): Promise<CrdtEventThroughputBenchmarkResult> {
  const normalizedEventCount = normalizePositiveInteger(eventCount);
  const normalizedRounds = normalizePositiveInteger(rounds);
  const seedRows = buildBenchmarkRows(normalizedEventCount);
  const baseTimestampMs = Date.now() + 60_000;

  onStatus?.("preparing snapshots...");

  const sourceHarness = await createSyncBenchmarkHarness();

  try {
    const emptySnapshot = sourceHarness.reactiveDb.createSnapshot();
    insertRows(sourceHarness.db, "benchmark", seedRows);
    const seededSnapshot = sourceHarness.reactiveDb.createSnapshot();

    const createEvents = buildRemoteCreateEvents(normalizedEventCount, { baseTimestampMs });
    const updateEvents = buildRemoteUpdateEvents(normalizedEventCount, { baseTimestampMs: baseTimestampMs + 1_000 });
    const deleteEvents = buildRemoteDeleteEvents(normalizedEventCount, { baseTimestampMs: baseTimestampMs + 2_000 });

    onStatus?.("measuring workloads...");

    const createStats = summarizeDurations(
      "Remote create events",
      await measureRemoteEventDurations({
        rounds: normalizedRounds,
        snapshot: emptySnapshot,
        events: createEvents,
        expectedVisibleRows: normalizedEventCount,
      }),
    );
    const updateStats = summarizeDurations(
      "Remote update events",
      await measureRemoteEventDurations({
        rounds: normalizedRounds,
        snapshot: seededSnapshot,
        events: updateEvents,
        expectedVisibleRows: normalizedEventCount,
      }),
    );
    const deleteStats = summarizeDurations(
      "Remote delete events",
      await measureRemoteEventDurations({
        rounds: normalizedRounds,
        snapshot: seededSnapshot,
        events: deleteEvents,
        expectedVisibleRows: 0,
      }),
    );

    const rows = [
      summarizeThroughputRow(createStats, normalizedEventCount),
      summarizeThroughputRow(updateStats, normalizedEventCount),
      summarizeThroughputRow(deleteStats, normalizedEventCount),
    ];

    const createHarness = await createSyncBenchmarkHarness({ snapshot: emptySnapshot });
    const updateHarness = await createSyncBenchmarkHarness({ snapshot: seededSnapshot });
    const deleteHarness = await createSyncBenchmarkHarness({ snapshot: seededSnapshot });

    try {
      await applyRemoteEvents(createHarness, createEvents);
      await applyRemoteEvents(updateHarness, updateEvents);
      await applyRemoteEvents(deleteHarness, deleteEvents);

      return {
        eventCount: normalizedEventCount,
        rounds: normalizedRounds,
        rows,
        sanity: {
          create: `Create sanity check: ${countRows(createHarness.db, "benchmark")} visible rows, ${countEventsByStatus(createHarness.db, "applied")} applied events`,
          update: `Update sanity check: item-1 value is ${getBenchmarkValue(updateHarness.db, "item-1")}`,
          delete: `Delete sanity check: ${countRows(deleteHarness.db, "benchmark")} visible rows remain`,
        },
      };
    } finally {
      createHarness.dispose();
      updateHarness.dispose();
      deleteHarness.dispose();
    }
  } finally {
    sourceHarness.dispose();
  }
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

  const onEventsApplied = () => checkCompletion();
  harness.crdtStorage.addEventListener("events-applied", onEventsApplied);
  try {
    await harness.crdtStorage.enqueueRemoteEvents(events).processed;
    checkCompletion();
    await completion.promise;
  } finally {
    harness.crdtStorage.removeEventListener("events-applied", onEventsApplied);
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

function normalizePositiveInteger(value: number) {
  return Math.max(1, Math.floor(Number(value) || 1));
}
