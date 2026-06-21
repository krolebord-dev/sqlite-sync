import { describe, expect, it } from "vitest";
import { createExportData, createImportData, type SyncedDbExport } from "../src/export-import";
import { HLCCounter } from "../src/hlc";
import { createMemoryDb } from "../src/memory-db/memory-db";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { applyMemoryDbSchema } from "../src/migrations/system-schema";
import { t } from "../src/schema/table-builder";
import { CrdtEventValidationError } from "../src/schema/validate-crdt-event";
import type { CrdtUpdateLogItem, PersistedCrdtEvent } from "../src/sqlite-crdt/crdt-table-schema";
import { makeCrdtTable } from "../src/sqlite-crdt/make-crdt-table";

const BASE_TABLE = "_todo";
const CRDT_TABLE = "todo";
const SCHEMA_VERSION = 0;

const todoSyncSchema = {
  tablesConfig: [{ baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE }],
  tables: {
    [CRDT_TABLE]: t.table({
      title: t.text(),
      completed: t.boolean(),
    }),
  },
};

type RawTodoRow = {
  id: string;
  title: string;
  completed: number | boolean;
  tombstone: number | boolean;
};

const noopLogger = () => {};

async function createReplica(nodeId: string) {
  const reactiveDb = await createSQLiteReactiveDb<{
    [BASE_TABLE]: RawTodoRow;
    [CRDT_TABLE]: RawTodoRow;
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
      "completed" INTEGER NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )
  `);
  applyMemoryDbSchema(db);
  makeCrdtTable({ db, baseTableName: BASE_TABLE, crdtTableName: CRDT_TABLE });

  const migrator = createMigrator({
    migrations: createMigrations(() => ({ 0: [] })),
    schemaVersion: { current: SCHEMA_VERSION },
  });
  const { crdtStorage } = await createMemoryDb({
    nodeId,
    migrator,
    reactiveDb,
    hlcCounter: new HLCCounter(nodeId, () => 1),
    crdtTables: todoSyncSchema.tablesConfig,
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
    throw new Error(`Replica ${nodeId} still has pending events after waiting`);
  };

  const exportData = createExportData({
    reactiveDb,
    tablesConfig: todoSyncSchema.tablesConfig,
    schemaVersion: migrator.currentSchemaVersion,
  });
  const importData = createImportData({
    migrator,
    tablesConfig: todoSyncSchema.tablesConfig,
    applyEvents: (events) => crdtStorage.applyOwnEvents(events),
  });

  return {
    db,
    crdtStorage,
    exportData,
    importData,
    waitForProcessing,
    async createTodo(todo: { id: string; title: string; completed: boolean }) {
      db.execute({
        sql: `INSERT INTO "${CRDT_TABLE}" ("id", "title", "completed", "tombstone") VALUES (?, ?, ?, ?)`,
        parameters: [todo.id, todo.title, Number(todo.completed), 0],
      });
      await waitForProcessing();
    },
    async deleteTodo(id: string) {
      db.execute({ sql: `DELETE FROM "${CRDT_TABLE}" WHERE "id" = ?`, parameters: [id] });
      await waitForProcessing();
    },
    activeTodos() {
      return db
        .execute<RawTodoRow>(`SELECT * FROM "${CRDT_TABLE}" ORDER BY "id" ASC`)
        .rows.map((row) => ({ id: row.id, title: row.title, completed: Boolean(row.completed) }));
    },
  };
}

describe("export/import", () => {
  it("exports active rows in a versioned envelope, excluding tombstone", async () => {
    const replica = await createReplica("a");
    await replica.createTodo({ id: "1", title: "buy milk", completed: false });
    await replica.createTodo({ id: "2", title: "walk dog", completed: true });

    const dump = replica.exportData();

    expect(dump.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof dump.exportedAt).toBe("string");
    expect(dump.tables[BASE_TABLE]).toEqual([
      { id: "1", title: "buy milk", completed: 0 },
      { id: "2", title: "walk dog", completed: 1 },
    ]);
    expect(dump.tables[CRDT_TABLE]).toBeUndefined();
    for (const row of dump.tables[BASE_TABLE]) {
      expect(row).not.toHaveProperty("tombstone");
    }
  });

  it("excludes tombstoned (deleted) rows from the export", async () => {
    const replica = await createReplica("a");
    await replica.createTodo({ id: "1", title: "keep", completed: false });
    await replica.createTodo({ id: "2", title: "gone", completed: false });
    await replica.deleteTodo("2");

    const dump = replica.exportData();

    expect(dump.tables[BASE_TABLE].map((row) => row.id)).toEqual(["1"]);
  });

  it("round-trips into a fresh replica (booleans included)", async () => {
    const source = await createReplica("a");
    await source.createTodo({ id: "1", title: "buy milk", completed: false });
    await source.createTodo({ id: "2", title: "walk dog", completed: true });

    const dump = source.exportData();

    const target = await createReplica("b");
    const result = target.importData(dump);
    await target.waitForProcessing();

    expect(result).toEqual({ imported: 2 });
    expect(target.activeTodos()).toEqual([
      { id: "1", title: "buy milk", completed: false },
      { id: "2", title: "walk dog", completed: true },
    ]);
  });

  it("overwrites existing rows by default without duplicating", async () => {
    const replica = await createReplica("a");
    await replica.createTodo({ id: "1", title: "old", completed: false });

    // Older exports used the public CRDT table name; imports still accept and normalize it.
    replica.importData({
      schemaVersion: SCHEMA_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tables: { [CRDT_TABLE]: [{ id: "1", title: "new", completed: true }] },
    });
    await replica.waitForProcessing();

    expect(replica.activeTodos()).toEqual([{ id: "1", title: "new", completed: true }]);
  });

  it("throws on schema version mismatch and applies nothing", async () => {
    const replica = await createReplica("a");
    const dump: SyncedDbExport = {
      schemaVersion: SCHEMA_VERSION + 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tables: { [CRDT_TABLE]: [{ id: "1", title: "x", completed: false }] },
    };

    expect(() => replica.importData(dump)).toThrow(/schema version/);
    expect(replica.activeTodos()).toEqual([]);

    // validate:false bypasses the version check
    replica.importData(dump, { validate: false });
    await replica.waitForProcessing();
    expect(replica.activeTodos()).toEqual([{ id: "1", title: "x", completed: false }]);
  });

  it("throws CrdtEventValidationError on invalid payloads and applies nothing", async () => {
    const replica = await createReplica("a");
    const dump: SyncedDbExport = {
      schemaVersion: SCHEMA_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tables: { [CRDT_TABLE]: [{ id: "1", title: 123, completed: false }] },
    };

    expect(() => replica.importData(dump)).toThrow(CrdtEventValidationError);
    expect(replica.activeTodos()).toEqual([]);
  });

  it("forward-migrates an older export into a newer schema, applying new column defaults", async () => {
    const BASE = "_note";
    const CRDT = "note";

    const reactiveDb = await createSQLiteReactiveDb<{
      [BASE]: { id: string; title: string; priority: number; tombstone: number };
      [CRDT]: { id: string; title: string; priority: number; tombstone: number };
      persisted_crdt_events: PersistedCrdtEvent;
      crdt_update_log: CrdtUpdateLogItem;
    }>({ snapshot: new Uint8Array(), logger: noopLogger });
    const db = reactiveDb.db;

    // The DB is at schema version 1: `priority` was added by migration 1.
    db.execute(`
      CREATE TABLE "${BASE}" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "priority" INTEGER NOT NULL DEFAULT 0,
        "tombstone" INTEGER NOT NULL DEFAULT 0
      )
    `);
    applyMemoryDbSchema(db);
    makeCrdtTable({ db, baseTableName: BASE, crdtTableName: CRDT });

    const syncSchema = {
      tablesConfig: [{ baseTableName: BASE, crdtTableName: CRDT }],
      tables: { [CRDT]: t.table({ title: t.text(), priority: t.integer() }) },
    };

    const migrator = createMigrator({
      migrations: createMigrations((steps) => ({
        0: [],
        1: [steps.addColumn({ table: BASE, column: "priority", type: "integer", defaultValue: 0 })],
      })),
      schemaVersion: { current: 1 },
    });

    const { crdtStorage } = await createMemoryDb({
      nodeId: "v1",
      migrator,
      reactiveDb,
      hlcCounter: new HLCCounter("v1", () => 1),
      crdtTables: syncSchema.tablesConfig,
      syncDbSchema: syncSchema,
      initializeSchema: false,
    });

    const importData = createImportData({
      migrator,
      tablesConfig: syncSchema.tablesConfig,
      applyEvents: (events) => crdtStorage.applyOwnEvents(events),
    });

    // A dump produced by an older build at schema version 0, before `priority`
    // existed, and before exports were keyed by base table name.
    const result = importData({
      schemaVersion: 0,
      exportedAt: "2026-01-01T00:00:00.000Z",
      tables: { [CRDT]: [{ id: "1", title: "older" }] },
    });
    expect(result).toEqual({ imported: 1 });

    for (let attempt = 0; attempt < 50; attempt++) {
      const [{ pendingCount }] = db.execute<{ pendingCount: number }>(
        `SELECT count(*) AS pendingCount FROM "persisted_crdt_events" WHERE "status" = 'pending'`,
      ).rows;
      if (pendingCount === 0) break;
      await Promise.resolve();
    }

    const [row] = db.execute<{ id: string; title: string; priority: number }>(
      `SELECT "id", "title", "priority" FROM "${CRDT}"`,
    ).rows;
    expect(row).toEqual({ id: "1", title: "older", priority: 0 });
  });
});
