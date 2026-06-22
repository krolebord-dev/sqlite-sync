import { describe, expect, it } from "vitest";
import { HLCCounter, serializeHLC } from "../src/hlc";
import { createMemoryDb } from "../src/memory-db/memory-db";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { applyMemoryDbSchema } from "../src/migrations/system-schema";
import { t } from "../src/schema/table-builder";
import type { CrdtUpdateLogItem, PersistedCrdtEvent } from "../src/sqlite-crdt/crdt-table-schema";
import { makeCrdtTable } from "../src/sqlite-crdt/make-crdt-table";

const BASE_TABLE = "todo";
const CRDT_TABLE = "_todo";

const noopLogger = () => {};

// `note` is NOT NULL with a SQL DEFAULT, matching the prod schema shape that
// triggered the de-sync (`counterpartyAccountId TEXT NOT NULL DEFAULT ''`).
const todoSyncSchema = {
  tablesConfig: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
  tables: {
    [CRDT_TABLE]: t.table({
      title: t.text(),
      note: t.text().default(""),
    }),
  },
};

type RemoteEvent = Pick<
  PersistedCrdtEvent,
  "type" | "dataset" | "item_id" | "payload" | "timestamp" | "schema_version"
>;

type TodoRow = { id: string; title: string; note: string };

async function setup() {
  const reactiveDb = await createSQLiteReactiveDb<{
    [BASE_TABLE]: TodoRow & { tombstone: number };
    [CRDT_TABLE]: TodoRow & { tombstone: number };
    persisted_crdt_events: PersistedCrdtEvent;
    crdt_update_log: CrdtUpdateLogItem;
  }>({
    snapshot: new Uint8Array(),
    logger: noopLogger,
  });
  const db = reactiveDb.db;

  db.execute(`
    CREATE TABLE "${BASE_TABLE}" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "note" TEXT NOT NULL DEFAULT '',
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )
  `);
  applyMemoryDbSchema(db);
  makeCrdtTable({ db, baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE });

  const schemaVersion = { current: 0 };
  const { crdtStorage: storage } = await createMemoryDb({
    nodeId: "node-a",
    migrator: createMigrator({ migrations: createMigrations(() => ({ 0: [] })), schemaVersion }),
    reactiveDb,
    hlcCounter: new HLCCounter("node-a", () => 1_000),
    crdtTables: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
    syncDbSchema: todoSyncSchema,
    initializeSchema: false,
  });

  const waitForProcessing = async () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const [{ pendingCount }] = db.execute<{ pendingCount: number }>(
        `SELECT count(*) AS pendingCount FROM "persisted_crdt_events" WHERE "status" = 'pending'`,
      ).rows;
      if (pendingCount === 0) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error("Replica still has pending events after waiting");
  };

  return {
    async apply(events: RemoteEvent[]) {
      storage.enqueueRemoteEvents(events);
      await waitForProcessing();
    },
    getTodo(id: string) {
      return db.execute<TodoRow>({
        sql: `SELECT "id", "title", "note" FROM "${BASE_TABLE}" WHERE "id" = ?`,
        parameters: [id],
      }).rows[0];
    },
  };
}

function createEvent(id: string, time: number, payload: Record<string, unknown>): RemoteEvent {
  return {
    type: "item-created",
    dataset: BASE_TABLE,
    item_id: id,
    timestamp: serializeHLC(new HLCCounter("remote-node", () => time).getCurrentHLC()),
    schema_version: 0,
    payload: JSON.stringify({ id, ...payload }),
  };
}

// Both create events target the same dataset but carry different column sets.
// executePrepared caches the compiled INSERT by key; before the fix the key was
// dataset-only, so the first applied event froze the column list for the process.
const fullEvent = createEvent("todo-full", 1_000, { title: "Full", note: "explicit note" });
const partialEvent = createEvent("todo-partial", 1_001, { title: "Partial" });

describe("insertItem prepared-statement cache key", () => {
  it("applies full then partial create without violating NOT NULL", async () => {
    const replica = await setup();
    await replica.apply([fullEvent, partialEvent]);

    expect(replica.getTodo("todo-full")).toEqual({ id: "todo-full", title: "Full", note: "explicit note" });
    // Omitted column must fall back to the table DEFAULT, not bind NULL.
    expect(replica.getTodo("todo-partial")).toEqual({ id: "todo-partial", title: "Partial", note: "" });
  });

  it("applies partial then full create without dropping the explicit value", async () => {
    const replica = await setup();
    await replica.apply([partialEvent, fullEvent]);

    expect(replica.getTodo("todo-partial")).toEqual({ id: "todo-partial", title: "Partial", note: "" });
    // The stale dataset-only key would have reused the column-less statement here,
    // silently dropping `note` instead of inserting "explicit note".
    expect(replica.getTodo("todo-full")).toEqual({ id: "todo-full", title: "Full", note: "explicit note" });
  });
});
