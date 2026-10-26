import { describe, expect, it } from "vitest";
import { HLCCounter, serializeHLC } from "../src/hlc";
import { createMemoryDb } from "../src/memory-db/memory-db";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { applyMemoryDbSchema } from "../src/migrations/system-schema";
import { t } from "../src/schema/table-builder";
import type { CrdtUpdateLogItem, PersistedCrdtEvent } from "../src/sqlite-crdt/crdt-table-schema";
import { makeCrdtTable } from "../src/sqlite-crdt/make-crdt-table";

const BASE_TABLE = "todo";
const CRDT_TABLE = "_todo";

const syncSchema = {
  tablesConfig: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
  tables: {
    [CRDT_TABLE]: t.table({ title: t.text() }),
  },
};

async function setup() {
  const reactiveDb = await createSQLiteReactiveDb<{
    [BASE_TABLE]: { id: string; title: string; tombstone: number };
    [CRDT_TABLE]: { id: string; title: string; tombstone: number };
    persisted_crdt_events: PersistedCrdtEvent;
    crdt_update_log: CrdtUpdateLogItem;
  }>({ snapshot: new Uint8Array(), logger: () => {} });
  const db = reactiveDb.db;

  db.execute(`
    CREATE TABLE "${BASE_TABLE}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )
  `);
  applyMemoryDbSchema(db);
  makeCrdtTable({ db, baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE });

  const { crdtStorage: storage } = await createMemoryDb({
    nodeId: "node-a",
    migrator: createMigrator({ migrations: createMigrations(() => ({ 0: [] })), schemaVersion: { current: 0 } }),
    reactiveDb,
    hlcCounter: new HLCCounter("node-a", () => 1_000),
    crdtTables: syncSchema.tablesConfig,
    syncDbSchema: syncSchema,
    initializeSchema: false,
  });

  const persistedSyncIds = () =>
    db
      .execute<{ sync_id: number }>(`SELECT "sync_id" FROM "persisted_crdt_events" ORDER BY "sync_id"`)
      .rows.map((row) => row.sync_id);

  const getAppliedCursor = () =>
    storage.getEventsBatch({ status: "applied", afterSyncId: 0, excludeOrigin: "remote", limit: 50 }).nextSyncId;

  return { db, storage, persistedSyncIds, getAppliedCursor };
}

const failingUpdate = {
  type: "item-updated" as const,
  dataset: BASE_TABLE,
  item_id: "missing",
  payload: JSON.stringify({ title: "x" }),
};

describe("sync id allocation", () => {
  it("does not publish ids taken by a rolled-back applyOwnEvents", async () => {
    const { storage, persistedSyncIds, getAppliedCursor } = await setup();

    expect(() => storage.applyOwnEvents([failingUpdate])).toThrow(/not found/);
    await storage.internal.processEnqueuedEvents();

    expect(persistedSyncIds()).toEqual([]);
    expect(getAppliedCursor()).toBe(0);
  });

  it("does not publish ids taken by a rolled-back view write", async () => {
    const { db, storage, persistedSyncIds, getAppliedCursor } = await setup();

    db.execute(`INSERT INTO "${CRDT_TABLE}" ("id", "title") VALUES ('1', 'a')`);
    expect(() => db.execute(`INSERT INTO "${CRDT_TABLE}" ("id") VALUES ('bad')`)).toThrow(/NOT NULL/);
    await storage.internal.processEnqueuedEvents();

    expect(persistedSyncIds()).toEqual([1]);
    expect(getAppliedCursor()).toBe(1);

    db.execute(`INSERT INTO "${CRDT_TABLE}" ("id", "title") VALUES ('2', 'b')`);
    expect(persistedSyncIds()).toEqual([1, 2]);
  });

  it("reports enqueue bounds from persisted ids after a rolled-back write", async () => {
    const { storage, persistedSyncIds } = await setup();

    expect(() => storage.applyOwnEvents([failingUpdate])).toThrow(/not found/);
    const result = storage.enqueueLocalEvents(
      [
        {
          type: "item-created",
          dataset: BASE_TABLE,
          item_id: "1",
          payload: JSON.stringify({ id: "1", title: "a" }),
          timestamp: serializeHLC({ timestamp: 2_000, counter: 0, nodeId: "node-b" }),
          schema_version: 0,
        },
      ],
      "node-b",
    );
    await result.processed;

    expect(result).toMatchObject({ beforeSyncId: 0, afterSyncId: 1 });
    expect(persistedSyncIds()).toEqual([1]);
  });
});
