import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSQLiteReactiveDb, type SQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { applyMemoryDbSchema, type MemoryDbSchema, memoryDbConfig } from "../src/migrations/system-schema";
import { createStoredValue } from "../src/sqlite-crdt/stored-value";
import { runWorkerEventLogGc } from "../src/worker-db/event-log-gc";

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

  it("keeps the latest 100 applied or deduped events", () => {
    insertEvents({ from: 1, to: 150, origin: "remote", status: "applied" });

    const result = runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: -1 }),
      eventHlcAccumulator: createStoredValue({ initialValue: "00000000000000000000000000000000" }),
    });

    expect(result).toEqual({ skipped: false });
    expect(getEventStats()).toEqual({ count: 100, minSyncId: 51, maxSyncId: 150 });
  });

  it("does not delete local events that have not been pushed", () => {
    insertEvents({ from: 1, to: 160, origin: "local", status: "applied" });

    const result = runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: 30 }),
      eventHlcAccumulator: createStoredValue({ initialValue: "00000000000000000000000000000000" }),
    });

    expect(result).toEqual({ skipped: false });
    expect(getEventStats()).toEqual({ count: 130, minSyncId: 31, maxSyncId: 160 });
  });

  it("does not delete pending or failed events", () => {
    insertEvents({ from: 1, to: 1, origin: "remote", status: "pending" });
    insertEvents({ from: 2, to: 2, origin: "remote", status: "failed" });
    insertEvents({ from: 3, to: 152, origin: "remote", status: "applied" });

    const result = runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: -1 }),
      eventHlcAccumulator: createStoredValue({ initialValue: "00000000000000000000000000000000" }),
    });

    expect(result).toEqual({ skipped: false });
    expect(selectSyncIdsByStatus("pending")).toEqual([1]);
    expect(selectSyncIdsByStatus("failed")).toEqual([2]);
    expect(getEventStats()).toEqual({ count: 102, minSyncId: 1, maxSyncId: 152 });
  });

  it("skips GC until the HLC checksum has been computed from full history", () => {
    insertEvents({ from: 1, to: 150, origin: "remote", status: "applied" });

    const result = runWorkerEventLogGc({
      db: reactiveDb.db,
      dbConfig: memoryDbConfig,
      pushSyncId: createStoredValue({ initialValue: -1 }),
      eventHlcAccumulator: createStoredValue({ initialValue: "" }),
    });

    expect(result).toEqual({ skipped: true });
    expect(getEventStats()).toEqual({ count: 150, minSyncId: 1, maxSyncId: 150 });
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
