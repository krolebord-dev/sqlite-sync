import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";

type Database = { todo: { id: string; title: string } };

let db: SQLiteReactiveDb<Database> | null = null;

async function createDb() {
  db = await createSQLiteReactiveDb<Database>({ snapshot: new Uint8Array(), logger: () => {} });
  db.db.execute(`CREATE TABLE "todo" ("id" TEXT NOT NULL PRIMARY KEY, "title" TEXT NOT NULL)`);
  return db;
}

// Table events are dispatched from a microtask queued by the commit hook.
const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

let nextId = 0;
const insertTodo = (db: SQLiteReactiveDb<Database>) => {
  nextId++;
  db.db.execute({ sql: `INSERT INTO "todo" VALUES (?, ?)`, parameters: [`t${nextId}`, "x"] });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  db?.dispose();
  db = null;
});

describe("subscribeToQueryChanges", () => {
  it("notifies immediately for isolated changes separated by idle time", async () => {
    const db = await createDb();
    const onDataChange = vi.fn();
    db.subscribeToQueryChanges({ sql: `SELECT * FROM "todo"`, onDataChange });

    for (let i = 1; i <= 4; i++) {
      insertTodo(db);
      await flushMicrotasks();
      expect(onDataChange).toHaveBeenCalledTimes(i);
      await vi.advanceTimersByTimeAsync(1000);
      // Idle time must not produce extra calls either.
      expect(onDataChange).toHaveBeenCalledTimes(i);
    }
  });

  it("coalesces a burst into a leading call plus one trailing call", async () => {
    const db = await createDb();
    const onDataChange = vi.fn();
    db.subscribeToQueryChanges({ sql: `SELECT * FROM "todo"`, onDataChange });

    for (let i = 0; i < 10; i++) {
      insertTodo(db);
      await flushMicrotasks();
    }
    expect(onDataChange).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30);
    expect(onDataChange).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(onDataChange).toHaveBeenCalledTimes(2);
  });

  it("keeps notifying during a sustained burst instead of waiting for it to end", async () => {
    const db = await createDb();
    const onDataChange = vi.fn();
    db.subscribeToQueryChanges({ sql: `SELECT * FROM "todo"`, onDataChange });

    // A write every 10 ms for 300 ms.
    for (let i = 0; i < 30; i++) {
      insertTodo(db);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(10);
    }

    // Leading call plus roughly one per 30 ms window, rather than a single leading call.
    expect(onDataChange.mock.calls.length).toBeGreaterThanOrEqual(9);
  });
});
