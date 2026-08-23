import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { applyMemoryDbSchema, memoryDbConfig } from "../src/migrations/system-schema";
import { createSQLiteCrdtApplyFunction } from "../src/sqlite-crdt/apply-crdt-event";
import type { CrdtUpdateLogItem } from "../src/sqlite-crdt/crdt-table-schema";

const noopLogger = () => {};

describe("migrator update log", () => {
  it("preserves renamed column timestamps when the destination key exists", async () => {
    const reactiveDb = await createSQLiteReactiveDb<{
      todo: { id: string; title: string; obsolete: string; tombstone: number };
      task: { id: string; name: string; tombstone: number };
      crdt_update_log: CrdtUpdateLogItem;
    }>({
      snapshot: new Uint8Array(),
      logger: noopLogger,
    });
    const db = reactiveDb.db;

    db.execute(`CREATE TABLE "todo" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "obsolete" TEXT NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )`);
    applyMemoryDbSchema(db);
    db.execute(`INSERT INTO "todo" ("id", "title", "obsolete", "tombstone") VALUES ('item-1', 'newer', 'unused', 0)`);
    db.execute({
      sql: `INSERT INTO "crdt_update_log" ("dataset", "item_id", "payload") VALUES (?, ?, ?)`,
      parameters: [
        "todo",
        "item-1",
        JSON.stringify({
          id: "000000000000100:00000:node-a",
          title: "000000000000100:00000:node-a",
          name: "000000000000025:00000:node-a",
          obsolete: "000000000000100:00000:node-a",
          tombstone: "000000000000100:00000:node-a",
        }),
      ],
    });

    const schemaVersion = { current: 0 };
    const migrator = createMigrator({
      migrations: createMigrations((steps) => ({
        0: [],
        1: [
          steps.renameTable({ oldTable: "todo", newTable: "task" }),
          steps.renameColumn({ table: "task", oldColumn: "title", newColumn: "name" }),
          steps.dropColumn({ table: "task", column: "obsolete" }),
        ],
      })),
      schemaVersion,
      updateLogTableName: memoryDbConfig.updateLogTable.fullIdentifier,
    });

    migrator.migrateDbToLatest({
      startTransaction: (callback) => {
        db.executeTransaction((tx) =>
          callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
        );
      },
    });

    const [updateLog] = db.execute<CrdtUpdateLogItem>(`SELECT * FROM "crdt_update_log"`).rows;
    expect(updateLog.dataset).toBe("task");
    expect(JSON.parse(updateLog.payload)).toEqual({
      id: "000000000000100:00000:node-a",
      name: "000000000000100:00000:node-a",
      tombstone: "000000000000100:00000:node-a",
    });

    const delayedEvent = migrator.migrateEvent({
      schema_version: 0,
      type: "item-updated",
      dataset: "todo",
      item_id: "item-1",
      payload: JSON.stringify({ title: "older" }),
      timestamp: "000000000000050:00000:node-b",
    });
    expect(delayedEvent).not.toBeNull();
    if (delayedEvent === null) {
      throw new Error("Expected the delayed event to migrate");
    }

    const applyCrdtEvent = createSQLiteCrdtApplyFunction({ db, dbConfig: memoryDbConfig });
    applyCrdtEvent(delayedEvent);

    const [item] = db.execute<{ name: string }>(`SELECT "name" FROM "task" WHERE "id" = 'item-1'`).rows;
    expect(item.name).toBe("newer");
  });

  it("clears a stale timestamp when adding a column with a reused name", async () => {
    const reactiveDb = await createSQLiteReactiveDb<{
      todo: { id: string; title: string; priority: number; tombstone: number };
      crdt_update_log: CrdtUpdateLogItem;
    }>({
      snapshot: new Uint8Array(),
      logger: noopLogger,
    });
    const db = reactiveDb.db;

    db.execute(`CREATE TABLE "todo" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )`);
    applyMemoryDbSchema(db);
    db.execute(`INSERT INTO "todo" ("id", "title", "tombstone") VALUES ('item-1', 'one', 0)`);
    db.execute({
      sql: `INSERT INTO "crdt_update_log" ("dataset", "item_id", "payload") VALUES (?, ?, ?)`,
      parameters: [
        "todo",
        "item-1",
        JSON.stringify({
          id: "000000000000100:00000:node-a",
          title: "000000000000100:00000:node-a",
          priority: "000000000000100:00000:node-a",
          tombstone: "000000000000100:00000:node-a",
        }),
      ],
    });

    const schemaVersion = { current: 0 };
    const migrator = createMigrator({
      migrations: createMigrations((steps) => ({
        0: [],
        1: [steps.addColumn({ table: "todo", column: "priority", type: "integer", defaultValue: 0 })],
      })),
      schemaVersion,
      updateLogTableName: memoryDbConfig.updateLogTable.fullIdentifier,
    });

    migrator.migrateDbToLatest({
      startTransaction: (callback) => {
        db.executeTransaction((tx) =>
          callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
        );
      },
    });

    const [updateLog] = db.execute<CrdtUpdateLogItem>(`SELECT * FROM "crdt_update_log"`).rows;
    expect(JSON.parse(updateLog.payload)).toEqual({
      id: "000000000000100:00000:node-a",
      title: "000000000000100:00000:node-a",
      tombstone: "000000000000100:00000:node-a",
    });

    const event = migrator.migrateEvent({
      schema_version: 1,
      type: "item-updated",
      dataset: "todo",
      item_id: "item-1",
      payload: JSON.stringify({ priority: 5 }),
      timestamp: "000000000000050:00000:node-b",
    });
    expect(event).not.toBeNull();
    if (event === null) {
      throw new Error("Expected the event to migrate");
    }

    const applyCrdtEvent = createSQLiteCrdtApplyFunction({ db, dbConfig: memoryDbConfig });
    applyCrdtEvent(event);

    const [item] = db.execute<{ priority: number }>(`SELECT "priority" FROM "todo" WHERE "id" = 'item-1'`).rows;
    expect(item.priority).toBe(5);
  });

  it("clears a stale destination timestamp when renaming a column without a source timestamp", async () => {
    const reactiveDb = await createSQLiteReactiveDb<{
      todo: { id: string; name: string; tombstone: number };
      crdt_update_log: CrdtUpdateLogItem;
    }>({
      snapshot: new Uint8Array(),
      logger: noopLogger,
    });
    const db = reactiveDb.db;

    db.execute(`CREATE TABLE "todo" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )`);
    applyMemoryDbSchema(db);
    db.execute(`INSERT INTO "todo" ("id", "tombstone") VALUES ('item-1', 0)`);
    db.execute({
      sql: `INSERT INTO "crdt_update_log" ("dataset", "item_id", "payload") VALUES (?, ?, ?)`,
      parameters: [
        "todo",
        "item-1",
        JSON.stringify({
          id: "000000000000100:00000:node-a",
          name: "000000000000100:00000:node-a",
          tombstone: "000000000000100:00000:node-a",
        }),
      ],
    });

    const schemaVersion = { current: 0 };
    const migrator = createMigrator({
      migrations: createMigrations((steps) => ({
        0: [],
        1: [steps.addColumn({ table: "todo", column: "title", type: "text", defaultValue: "default" })],
        2: [steps.renameColumn({ table: "todo", oldColumn: "title", newColumn: "name" })],
      })),
      schemaVersion,
      updateLogTableName: memoryDbConfig.updateLogTable.fullIdentifier,
    });

    migrator.migrateDbToLatest({
      startTransaction: (callback) => {
        db.executeTransaction((tx) =>
          callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
        );
      },
    });

    const [updateLog] = db.execute<CrdtUpdateLogItem>(`SELECT * FROM "crdt_update_log"`).rows;
    expect(JSON.parse(updateLog.payload)).toEqual({
      id: "000000000000100:00000:node-a",
      tombstone: "000000000000100:00000:node-a",
    });

    const event = migrator.migrateEvent({
      schema_version: 2,
      type: "item-updated",
      dataset: "todo",
      item_id: "item-1",
      payload: JSON.stringify({ name: "written" }),
      timestamp: "000000000000050:00000:node-b",
    });
    expect(event).not.toBeNull();
    if (event === null) {
      throw new Error("Expected the event to migrate");
    }

    const applyCrdtEvent = createSQLiteCrdtApplyFunction({ db, dbConfig: memoryDbConfig });
    applyCrdtEvent(event);

    const [item] = db.execute<{ name: string }>(`SELECT "name" FROM "todo" WHERE "id" = 'item-1'`).rows;
    expect(item.name).toBe("written");
  });

  it("removes stale destination rows before renaming a table dataset", async () => {
    const reactiveDb = await createSQLiteReactiveDb<{
      todo: { id: string; title: string; tombstone: number };
      task: { id: string; title: string; tombstone: number };
      crdt_update_log: CrdtUpdateLogItem;
    }>({
      snapshot: new Uint8Array(),
      logger: noopLogger,
    });
    const db = reactiveDb.db;

    db.execute(`CREATE TABLE "todo" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )`);
    applyMemoryDbSchema(db);
    db.execute(`INSERT INTO "todo" ("id", "title", "tombstone") VALUES ('item-1', 'current', 0)`);
    db.execute({
      sql: `INSERT INTO "crdt_update_log" ("dataset", "item_id", "payload") VALUES (?, ?, ?)`,
      parameters: ["todo", "item-1", JSON.stringify({ title: "current-timestamp" })],
    });
    db.execute({
      sql: `INSERT INTO "crdt_update_log" ("dataset", "item_id", "payload") VALUES (?, ?, ?), (?, ?, ?)`,
      parameters: [
        "task",
        "item-1",
        JSON.stringify({ title: "stale-timestamp" }),
        "task",
        "item-2",
        JSON.stringify({ title: "also-stale" }),
      ],
    });

    const schemaVersion = { current: 0 };
    const migrator = createMigrator({
      migrations: createMigrations((steps) => ({
        0: [],
        1: [steps.renameTable({ oldTable: "todo", newTable: "task" })],
      })),
      schemaVersion,
      updateLogTableName: memoryDbConfig.updateLogTable.fullIdentifier,
    });

    migrator.migrateDbToLatest({
      startTransaction: (callback) => {
        db.executeTransaction((tx) =>
          callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
        );
      },
    });

    expect(db.execute<{ title: string }>(`SELECT "title" FROM "task"`).rows).toEqual([{ title: "current" }]);
    expect(db.execute<CrdtUpdateLogItem>(`SELECT * FROM "crdt_update_log"`).rows).toEqual([
      {
        dataset: "task",
        item_id: "item-1",
        payload: JSON.stringify({ title: "current-timestamp" }),
      },
    ]);
  });
});
