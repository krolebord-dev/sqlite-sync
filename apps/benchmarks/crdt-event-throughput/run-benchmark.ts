import { createDeferredPromise, type SQLiteDbWrapper } from "@sqlite-sync/core";
import {
  buildBenchmarkRows,
  buildRemoteCreateEvents,
  buildRemoteDeleteEvents,
  buildRemoteUpdateEvents,
  countEventsByStatus,
  countRows,
  createSyncBenchmarkHarness,
  deleteRows,
  insertRows,
  measureSyncSnapshotDurations,
  type SyncBenchmarkDbSchema,
  updateRows,
} from "../src/benchmark-db";
import { type MeasurementRow, summarizeDurations } from "../src/benchmarks-common";

export type ThroughputMeasurementRow = MeasurementRow & {
  eventsPerWorkload: number;
  throughputEventsPerSecond: number;
};

export type CrdtEventThroughputBenchmarkResult = {
  eventCount: number;
  ownEventCount: number;
  rounds: number;
  rows: ThroughputMeasurementRow[];
  sanity: {
    create: string;
    update: string;
    delete: string;
    own: string;
  };
};

type BenchmarkHarness = Awaited<ReturnType<typeof createSyncBenchmarkHarness>>;
type RemoteEvents = Parameters<BenchmarkHarness["crdtStorage"]["enqueueRemoteEvents"]>[0];

export async function runCrdtEventThroughputBenchmark({
  eventCount,
  ownEventCount,
  rounds,
  onStatus,
}: {
  eventCount: number;
  ownEventCount?: number;
  rounds: number;
  onStatus?: (status: string) => void;
}): Promise<CrdtEventThroughputBenchmarkResult> {
  const normalizedEventCount = normalizePositiveInteger(eventCount);
  const normalizedOwnEventCount = ownEventCount
    ? normalizePositiveInteger(ownEventCount)
    : Math.max(1, Math.round(normalizedEventCount / 10));
  const normalizedRounds = normalizePositiveInteger(rounds);
  const seedRows = buildBenchmarkRows(normalizedEventCount);
  const ownRows = buildBenchmarkRows(normalizedOwnEventCount);
  const baseTimestampMs = Date.now() + 60_000;

  onStatus?.("preparing snapshots...");

  const sourceHarness = await createSyncBenchmarkHarness();

  try {
    const emptySnapshot = sourceHarness.reactiveDb.createSnapshot();
    insertRows(sourceHarness.db, "benchmark", seedRows);
    const seededSnapshot = sourceHarness.reactiveDb.createSnapshot();

    const ownSourceHarness = await createSyncBenchmarkHarness({ snapshot: emptySnapshot });
    let ownSeededSnapshot: Uint8Array<ArrayBufferLike>;
    try {
      insertRows(ownSourceHarness.db, "benchmark", ownRows);
      ownSeededSnapshot = ownSourceHarness.reactiveDb.createSnapshot();
    } finally {
      ownSourceHarness.dispose();
    }

    const createEvents = buildRemoteCreateEvents(normalizedEventCount, { baseTimestampMs });
    const updateEvents = buildRemoteUpdateEvents(normalizedEventCount, { baseTimestampMs: baseTimestampMs + 1_000 });
    const deleteEvents = buildRemoteDeleteEvents(normalizedEventCount, { baseTimestampMs: baseTimestampMs + 2_000 });

    onStatus?.("measuring remote workloads...");

    const remoteStats = [
      summarizeDurations(
        "Remote create events",
        await measureRemoteEventDurations({
          rounds: normalizedRounds,
          snapshot: emptySnapshot,
          events: createEvents,
          expectedVisibleRows: normalizedEventCount,
        }),
      ),
      summarizeDurations(
        "Remote update events",
        await measureRemoteEventDurations({
          rounds: normalizedRounds,
          snapshot: seededSnapshot,
          events: updateEvents,
          expectedVisibleRows: normalizedEventCount,
        }),
      ),
      summarizeDurations(
        "Remote delete events",
        await measureRemoteEventDurations({
          rounds: normalizedRounds,
          snapshot: seededSnapshot,
          events: deleteEvents,
          expectedVisibleRows: 0,
        }),
      ),
    ];

    onStatus?.("measuring own (local write) workloads...");

    const ownStats = [
      summarizeDurations(
        "Own create events (batched insert)",
        await measureOwnEventDurations({
          rounds: normalizedRounds,
          snapshot: emptySnapshot,
          expectedVisibleRows: normalizedOwnEventCount,
          write: (harness) => {
            insertRows(harness.db, "benchmark", ownRows);
          },
        }),
      ),
      summarizeDurations(
        "Own update events (row by row)",
        await measureOwnEventDurations({
          rounds: normalizedRounds,
          snapshot: ownSeededSnapshot,
          expectedVisibleRows: normalizedOwnEventCount,
          write: (harness) => {
            updateRows(harness.db, "benchmark", normalizedOwnEventCount);
          },
        }),
      ),
      summarizeDurations(
        "Own delete events (row by row)",
        await measureOwnEventDurations({
          rounds: normalizedRounds,
          snapshot: ownSeededSnapshot,
          expectedVisibleRows: 0,
          write: (harness) => {
            deleteRows(harness.db, "benchmark", normalizedOwnEventCount);
          },
        }),
      ),
    ];

    const rows = [
      ...remoteStats.map((row) => summarizeThroughputRow(row, normalizedEventCount)),
      ...ownStats.map((row) => summarizeThroughputRow(row, normalizedOwnEventCount)),
    ];

    const createHarness = await createSyncBenchmarkHarness({ snapshot: emptySnapshot });
    const updateHarness = await createSyncBenchmarkHarness({ snapshot: seededSnapshot });
    const deleteHarness = await createSyncBenchmarkHarness({ snapshot: seededSnapshot });
    const ownHarness = await createSyncBenchmarkHarness({ snapshot: emptySnapshot });

    try {
      await applyRemoteEvents(createHarness, createEvents);
      await applyRemoteEvents(updateHarness, updateEvents);
      await applyRemoteEvents(deleteHarness, deleteEvents);

      insertRows(ownHarness.db, "benchmark", ownRows);
      await waitForPendingEventsDrained(ownHarness);

      return {
        eventCount: normalizedEventCount,
        ownEventCount: normalizedOwnEventCount,
        rounds: normalizedRounds,
        rows,
        sanity: {
          create: `Create sanity check: ${countRows(createHarness.db, "benchmark")} visible rows, ${countEventsByStatus(createHarness.db, "applied")} applied events`,
          update: `Update sanity check: item-1 value is ${getBenchmarkValue(updateHarness.db, "item-1")}`,
          delete: `Delete sanity check: ${countRows(deleteHarness.db, "benchmark")} visible rows remain`,
          own: `Own sanity check: ${countRows(ownHarness.db, "benchmark")} visible rows, ${countEventsByStatus(ownHarness.db, "applied")} applied events`,
        },
      };
    } finally {
      createHarness.dispose();
      updateHarness.dispose();
      deleteHarness.dispose();
      ownHarness.dispose();
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
  events: RemoteEvents;
  expectedVisibleRows: number;
}) {
  return measureSyncSnapshotDurations({
    rounds,
    snapshot,
    task: async (harness) => {
      await applyRemoteEvents(harness, events);
      assertVisibleRows(harness, expectedVisibleRows);
    },
  });
}

async function measureOwnEventDurations({
  rounds,
  snapshot,
  write,
  expectedVisibleRows,
}: {
  rounds: number;
  snapshot: Uint8Array<ArrayBufferLike>;
  write: (harness: BenchmarkHarness) => void;
  expectedVisibleRows: number;
}) {
  return measureSyncSnapshotDurations({
    rounds,
    snapshot,
    task: async (harness) => {
      write(harness);
      await waitForPendingEventsDrained(harness);
      assertVisibleRows(harness, expectedVisibleRows);
    },
  });
}

function assertVisibleRows(harness: BenchmarkHarness, expectedVisibleRows: number) {
  const visibleRows = countRows(harness.db, "benchmark");
  if (visibleRows !== expectedVisibleRows) {
    throw new Error(`Expected ${expectedVisibleRows} visible rows after workload, got ${visibleRows}.`);
  }
}

async function applyRemoteEvents(harness: BenchmarkHarness, events: RemoteEvents) {
  const completion = createDeferredPromise<void>({ timeout: 120_000 });
  let lastAppliedSyncId = -1;
  let targetSyncId: number | null = null;

  const subscription = harness.crdtStorage.addEventListener("events-applied", (event) => {
    lastAppliedSyncId = Math.max(lastAppliedSyncId, event.payload.syncId);
    if (targetSyncId !== null && lastAppliedSyncId >= targetSyncId) {
      completion.resolve();
    }
  });

  try {
    const enqueued = harness.crdtStorage.enqueueRemoteEvents(events);
    targetSyncId = enqueued.afterSyncId;
    if (lastAppliedSyncId >= targetSyncId) {
      completion.resolve();
    }
    await enqueued.processed;
    await completion.promise;
  } finally {
    subscription.unsubscribe();
  }

  const failedCount = countEventsByStatus(harness.db, "failed");
  if (failedCount > 0) {
    throw new Error(`${failedCount} CRDT events failed to apply.`);
  }
}

async function waitForPendingEventsDrained(harness: BenchmarkHarness) {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    if (countEventsByStatus(harness.db, "pending") === 0) {
      const failedCount = countEventsByStatus(harness.db, "failed");
      if (failedCount > 0) {
        throw new Error(`${failedCount} CRDT events failed to apply.`);
      }
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error("Timed out waiting for pending CRDT events to drain.");
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
