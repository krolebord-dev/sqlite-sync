import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";
import { applyMemoryDbSchema, type MemoryDbSchema, memoryDbConfig } from "../src/migrations/system-schema";
import { createStoredValue } from "../src/sqlite-crdt/stored-value";
import {
  EVENT_LOG_GC_MAX_DELETED_EVENTS,
  runWorkerEventLogGc,
  WORKER_EVENT_LOG_GC_MIN_RETAINED_EVENTS,
} from "../src/worker-db/event-log-gc";
import { acquireReplicaLock, runWithNoActiveReplicas } from "../src/worker-db/replica-lock";

const noopLogger = () => {};

describe("worker event log GC", () => {
  let reactiveDb: SQLiteReactiveDb<MemoryDbSchema>;

  beforeEach(async () => {
    reactiveDb = await createSQLiteReactiveDb<MemoryDbSchema>({
      snapshot: new Uint8Array(),
      logger: noopLogger,
    });
    applyMemoryDbSchema(reactiveDb.db);
  });

  afterEach(() => {
    reactiveDb.dispose();
  });

  it.runIf(globalThis.navigator?.locks)(
    "retains history during worker handoff while an existing replica remains",
    async () => {
      insertEvents({ from: 1, to: 150, origin: "remote", status: "applied" });
      const dbId = crypto.randomUUID();
      const release = await acquireReplicaLock({ dbId });
      const cleanup = () =>
        runWithNoActiveReplicas({
          dbId,
          run: () => {
            runWorkerEventLogGc({
              db: reactiveDb.db,
              dbConfig: memoryDbConfig,
              pushSyncId: createStoredValue({ initialValue: -1 }),
            });
          },
        });

      try {
        expect(await cleanup()).toBe(false);
        expect(getEventStats()).toEqual({ count: 150, minSyncId: 1, maxSyncId: 150 });
        await release();
        expect(await cleanup()).toBe(true);
        expect(getEventStats()).toEqual({ count: 100, minSyncId: 51, maxSyncId: 150 });
      } finally {
        await release();
      }
    },
  );

  it("keeps the latest 100 applied or deduped events", () => {
    insertEvents({ from: 1, to: 150, origin: "remote", status: "applied" });

    runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: -1 }),
    });

    expect(getEventStats()).toEqual({ count: 100, minSyncId: 51, maxSyncId: 150 });
  });

  it("does not delete local events that have not been pushed", () => {
    insertEvents({ from: 1, to: 160, origin: "local", status: "applied" });

    runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: 30 }),
    });

    expect(getEventStats()).toEqual({ count: 130, minSyncId: 31, maxSyncId: 160 });
  });

  it("does not delete pending or failed events", () => {
    insertEvents({ from: 1, to: 1, origin: "remote", status: "pending" });
    insertEvents({ from: 2, to: 2, origin: "remote", status: "failed" });
    insertEvents({ from: 3, to: 152, origin: "remote", status: "applied" });

    runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: -1 }),
    });

    expect(selectSyncIdsByStatus("pending")).toEqual([1]);
    expect(selectSyncIdsByStatus("failed")).toEqual([2]);
    expect(getEventStats()).toEqual({ count: 102, minSyncId: 1, maxSyncId: 152 });
  });

  it("deletes a bounded number of events per run and continues on the next run", () => {
    const total = EVENT_LOG_GC_MAX_DELETED_EVENTS + 2500;
    reactiveDb.db.execute({
      sql: `
        WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM ids WHERE n < ?)
        INSERT INTO "persisted_crdt_events" (
          "sync_id", "schema_version", "status", "type", "timestamp", "origin",
          "source_node_id", "dataset", "item_id", "payload"
        )
        SELECT n, 0, 'applied', 'item-updated', 'timestamp-' || n, 'remote', '', '_todo', 'todo-' || n, '{}'
        FROM ids
      `,
      parameters: [total],
    });
    const runGc = () =>
      runWorkerEventLogGc({
        db: reactiveDb.db,
        dbConfig: memoryDbConfig,
        pushSyncId: createStoredValue({ initialValue: -1 }),
      });

    expect(runGc()).toBe(EVENT_LOG_GC_MAX_DELETED_EVENTS);
    expect(getEventStats()).toEqual({ count: 2500, minSyncId: EVENT_LOG_GC_MAX_DELETED_EVENTS + 1, maxSyncId: total });

    expect(runGc()).toBe(2500 - WORKER_EVENT_LOG_GC_MIN_RETAINED_EVENTS);
    expect(getEventStats()).toEqual({ count: 100, minSyncId: total - 99, maxSyncId: total });
  });

  it("logs a failure instead of throwing", () => {
    const logger = vi.fn();
    reactiveDb.db.execute(`DROP TABLE "persisted_crdt_events"`);

    expect(
      runWorkerEventLogGc({
        db: reactiveDb.db,
        dbConfig: memoryDbConfig,
        pushSyncId: createStoredValue({ initialValue: -1 }),
        logger,
      }),
    ).toBe(0);
    expect(logger).toHaveBeenCalledWith("worker", expect.stringContaining("Event log GC failed"), "warning");
  });

  function insertEvents({
    from,
    to,
    origin,
    status,
  }: {
    from: number;
    to: number;
    origin: "remote" | "local";
    status: "applied" | "deduped" | "pending" | "failed";
  }) {
    for (let syncId = from; syncId <= to; syncId++) {
      reactiveDb.db.execute({
        sql: `
          INSERT INTO "persisted_crdt_events" (
            "sync_id",
            "schema_version",
            "status",
            "type",
            "timestamp",
            "origin",
            "source_node_id",
            "dataset",
            "item_id",
            "payload"
          ) VALUES (?, 0, ?, 'item-updated', ?, ?, '', '_todo', ?, '{}')
        `,
        parameters: [syncId, status, `timestamp-${syncId}`, origin, `todo-${syncId}`],
      });
    }
  }

  function getEventStats() {
    return reactiveDb.db.execute<{ count: number; minSyncId: number | null; maxSyncId: number | null }>(
      `
        SELECT
          count(*) AS count,
          min("sync_id") AS minSyncId,
          max("sync_id") AS maxSyncId
        FROM "persisted_crdt_events"
      `,
    ).rows[0];
  }

  function selectSyncIdsByStatus(status: "pending" | "failed") {
    return reactiveDb.db
      .execute<{ sync_id: number }>({
        sql: `
          SELECT "sync_id"
          FROM "persisted_crdt_events"
          WHERE "status" = ?
          ORDER BY "sync_id" ASC
        `,
        parameters: [status],
      })
      .rows.map((row) => row.sync_id);
  }
});
