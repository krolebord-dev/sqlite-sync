import { afterEach, describe, expect, it } from "vitest";
import { createSQLiteReactiveDb, type SQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";

const noopLogger = () => {};

const QUERY = { sql: `SELECT * FROM "todo"`, parameters: [] as const };

type SharedLiveQueryInternals = {
  listeners: Set<() => void>;
  unsubscribeFromLiveQuery: (() => void) | null;
  cleanupTimeout: ReturnType<typeof setTimeout> | null;
};

let db: SQLiteReactiveDb<{ todo: { id: string; title: string } }> | null = null;

async function createDb() {
  db = await createSQLiteReactiveDb<{ todo: { id: string; title: string } }>({
    snapshot: new Uint8Array(),
    logger: noopLogger,
  });
  db.db.execute(`
    CREATE TABLE "todo" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL
    )
  `);
  return db;
}

async function flushCleanupTimers() {
  await new Promise((resolve) => setTimeout(resolve, 1));
  await new Promise((resolve) => setTimeout(resolve, 1));
}

afterEach(() => {
  db?.dispose();
  db = null;
});

describe("getSharedLiveQuery", () => {
  it("returns the same entry for identical sql and parameters", async () => {
    const db = await createDb();

    const first = db.getSharedLiveQuery(QUERY);
    const second = db.getSharedLiveQuery(QUERY);

    expect(second).toBe(first);
  });

  it("evicts an entry that never receives a subscriber", async () => {
    const db = await createDb();

    const first = db.getSharedLiveQuery(QUERY);
    await flushCleanupTimers();

    const second = db.getSharedLiveQuery(QUERY);
    expect(second).not.toBe(first);
  });

  it("keeps the entry alive when a subscriber attaches before eviction", async () => {
    const db = await createDb();

    const first = db.getSharedLiveQuery(QUERY);
    const unsubscribe = first.subscribe(() => {});
    await flushCleanupTimers();

    expect(db.getSharedLiveQuery(QUERY)).toBe(first);

    unsubscribe();
    await flushCleanupTimers();

    expect(db.getSharedLiveQuery(QUERY)).not.toBe(first);
  });

  it("tears down active subscriptions on dispose", async () => {
    const db = await createDb();

    const entry = db.getSharedLiveQuery(QUERY);
    entry.subscribe(() => {});

    const internals = entry as unknown as SharedLiveQueryInternals;
    expect(internals.unsubscribeFromLiveQuery).not.toBeNull();

    db.dispose();

    expect(internals.unsubscribeFromLiveQuery).toBeNull();
    expect(internals.listeners.size).toBe(0);
  });

  it("cancels pending eviction timers on dispose", async () => {
    const db = await createDb();

    const entry = db.getSharedLiveQuery(QUERY);

    const internals = entry as unknown as SharedLiveQueryInternals;
    expect(internals.cleanupTimeout).not.toBeNull();

    db.dispose();

    expect(internals.cleanupTimeout).toBeNull();
    await flushCleanupTimers();
  });

  it("keeps the entry alive when it is re-requested before eviction", async () => {
    const db = await createDb();

    const first = db.getSharedLiveQuery(QUERY);
    // Re-requesting cancels the pending eviction, so the timer must be re-armed
    // for the entry to ever be released.
    const second = db.getSharedLiveQuery(QUERY);
    expect(second).toBe(first);

    await flushCleanupTimers();
    expect(db.getSharedLiveQuery(QUERY)).not.toBe(first);
  });
});
