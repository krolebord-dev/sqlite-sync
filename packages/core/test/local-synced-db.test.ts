import { describe, expect, it, vi } from "vitest";
import { createLocalSyncedDb, type LocalSyncedDb } from "../src/local/local-synced-db";
import { createMigrations } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";
import type { CreateRemoteSourceFactory, EventsAvailable } from "../src/sqlite-crdt/crdt-sync-remote-source";
import type { SqliteDriver } from "../src/sqlite-driver";
import { createWasmSqliteDriver, loadSqliteWasm } from "../src/wasm-driver";
import type { EventsPullResponse } from "../src/worker-db/worker-common";

const schema = defineSyncSchema({
  tables: {
    todo: t.table({
      title: t.text(),
    }),
  },
  migrations: createMigrations((b) => ({
    0: [
      b.createTable("_todo", (table) =>
        table
          .addColumn("id", "text", (col) => col.primaryKey().notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
      ),
    ],
  })),
});

type Db = LocalSyncedDb<(typeof schema)["~clientSchema"]>;
type HookMode = "synchronous" | "asynchronous";

const noopLogger = () => {};

/**
 * In-memory stand-in for files on disk. The asynchronous mode mirrors op-sqlite: hooks are
 * delivered after the statement returns, and statements cannot report whether they are read-only.
 */
function createFileSystem(mode: HookMode) {
  const files = new Map<string, Uint8Array<ArrayBufferLike>>();
  const deleted: string[] = [];

  const open = async (name: string): Promise<SqliteDriver> => {
    const sqlite3 = await loadSqliteWasm();
    const inner = createWasmSqliteDriver(sqlite3, new sqlite3.oo1.DB({ filename: ":memory:" }));
    const file = files.get(name);
    if (file) {
      inner.deserialize?.(file);
    }

    const driver: SqliteDriver = {
      ...inner,
      close: () => {
        files.set(name, inner.serialize?.() ?? new Uint8Array());
        inner.close();
      },
    };
    if (mode === "synchronous") {
      return driver;
    }

    return {
      ...driver,
      synchronousHooks: false,
      prepare: (sql) => {
        const { run, finalize } = inner.prepare(sql);
        return { run, finalize };
      },
      setHooks: (hooks) =>
        inner.setHooks(
          hooks && {
            onUpdate: (table) => setTimeout(() => hooks.onUpdate(table)),
            onCommit: () => setTimeout(() => hooks.onCommit()),
            onRollback: () => setTimeout(() => hooks.onRollback()),
          },
        ),
    };
  };

  return {
    files,
    deleted,
    open,
    remove: (name: string) => {
      deleted.push(name);
      files.delete(name);
    },
  };
}

type ServerEvent = EventsPullResponse["events"][number] & { sync_id: number; source_node_id: string };

function createFakeServer() {
  const events: ServerEvent[] = [];
  const listeners = new Set<(event: EventsAvailable) => void>();

  const createRemoteSource: CreateRemoteSourceFactory = ({ onEventsAvailable }) => {
    listeners.add(onEventsAvailable);
    return {
      pullEvents: async ({ afterSyncId, excludeNodeId }) => {
        const page = events.filter((event) => event.sync_id > afterSyncId).slice(0, 100);
        return {
          events: page
            .filter((event) => event.source_node_id !== excludeNodeId)
            .map(({ sync_id: _syncId, source_node_id: _sourceNodeId, ...event }) => event),
          hasMore: events.length > afterSyncId + page.length,
          nextSyncId: page.at(-1)?.sync_id ?? afterSyncId,
        };
      },
      pushEvents: async ({ nodeId, events: pushed }) => {
        const beforeSyncId = events.length;
        for (const event of pushed) {
          events.push({ ...event, sync_id: events.length + 1, source_node_id: nodeId });
        }
        for (const listener of listeners) {
          listener({ newSyncId: events.length, remoteEventHlcSum: null });
        }
        return { ok: true, beforeSyncId, afterSyncId: events.length };
      },
      disconnect: () => {
        listeners.delete(onEventsAvailable);
      },
    };
  };

  return { events, createRemoteSource };
}

function createDb(
  fs: ReturnType<typeof createFileSystem>,
  name: string,
  opts: { server?: ReturnType<typeof createFakeServer>; storageVersion?: string } = {},
) {
  return createLocalSyncedDb({
    dbId: "local-test",
    syncDbSchema: schema,
    openDriver: () => fs.open(name),
    deleteDatabase: () => fs.remove(name),
    createRemoteSource: opts.server?.createRemoteSource,
    storageVersion: opts.storageVersion,
    logger: noopLogger,
  });
}

const todoTitles = (db: Db) =>
  db.db.execute<{ title: string }>(`SELECT "title" FROM "todo" ORDER BY "id"`).rows.map((row) => row.title);

const addTodo = (db: Db, id: string, title: string) =>
  db.db.execute({ sql: `INSERT INTO "todo" ("id", "title") VALUES (?, ?)`, parameters: [id, title] });

const countEvents = (db: Db, status: string) =>
  db.db.execute<{ count: number }>({
    sql: `SELECT count(*) AS "count" FROM "crdt_events" WHERE "status" = ?`,
    parameters: [status],
  }).rows[0]?.count;

describe.each<HookMode>(["synchronous", "asynchronous"])("createLocalSyncedDb with %s hooks", (mode) => {
  it("turns writes to CRDT views into events and pushes them", async () => {
    const fs = createFileSystem(mode);
    const server = createFakeServer();
    const db = await createDb(fs, "a", { server });

    addTodo(db, "1", "Buy milk");

    expect(todoTitles(db)).toEqual(["Buy milk"]);
    await vi.waitFor(() => expect(server.events).toHaveLength(1));
    expect(server.events[0]).toMatchObject({ type: "item-created", dataset: "_todo", item_id: "1" });
    expect(countEvents(db, "applied")).toBe(1);

    await db.dispose();
  });

  it("applies events pushed by another replica and updates live queries", async () => {
    const server = createFakeServer();
    const a = await createDb(createFileSystem(mode), "a", { server });
    const b = await createDb(createFileSystem(mode), "b", { server });

    const liveQuery = b.db.getSharedLiveQuery<{ title: string }>({
      sql: `SELECT "title" FROM "todo" ORDER BY "id"`,
      parameters: [],
    });
    const onChange = vi.fn();
    const unsubscribe = liveQuery.subscribe(onChange);
    expect(liveQuery.getRows()).toEqual([]);

    addTodo(a, "1", "From A");

    await vi.waitFor(() => expect(liveQuery.getRows()).toEqual([{ title: "From A" }]));
    expect(onChange).toHaveBeenCalled();
    expect(countEvents(b, "applied")).toBe(1);

    b.db.execute({ sql: `UPDATE "todo" SET "title" = ? WHERE "id" = ?`, parameters: ["Edited on B", "1"] });

    await vi.waitFor(() => expect(todoTitles(a)).toEqual(["Edited on B"]));
    // Each replica ignores its own events when they come back from the server.
    expect(server.events).toHaveLength(2);

    unsubscribe();
    await Promise.all([a.dispose(), b.dispose()]);
  });

  it("reopens a persisted database without recreating its schema", async () => {
    const fs = createFileSystem(mode);
    const first = await createDb(fs, "a");
    addTodo(first, "1", "Before restart");
    await vi.waitFor(() => expect(countEvents(first, "applied")).toBe(1));
    await first.dispose();

    const second = await createDb(fs, "a");
    expect(todoTitles(second)).toEqual(["Before restart"]);

    addTodo(second, "2", "After restart");
    expect(todoTitles(second)).toEqual(["Before restart", "After restart"]);
    await vi.waitFor(() => expect(countEvents(second, "applied")).toBe(2));
    const syncIds = second.db
      .execute<{ sync_id: number }>(`SELECT "sync_id" FROM "crdt_events" ORDER BY "sync_id"`)
      .rows.map((row) => row.sync_id);
    expect(syncIds).toEqual([1, 2]);

    const persistedObjects = second.db.execute<{ name: string }>(
      `SELECT "name" FROM "sqlite_master" WHERE "name" IN ('todo', 'crdt_change_intents')`,
    ).rows;
    expect(persistedObjects).toEqual([]);

    await second.dispose();
  });

  it("pushes events written while offline after a restart", async () => {
    const fs = createFileSystem(mode);
    const offline = await createDb(fs, "a");
    addTodo(offline, "1", "Written offline");
    await vi.waitFor(() => expect(countEvents(offline, "applied")).toBe(1));
    await offline.dispose();

    const server = createFakeServer();
    const online = await createDb(fs, "a", { server });

    await vi.waitFor(() => expect(server.events).toHaveLength(1));
    expect(server.events[0]).toMatchObject({ item_id: "1" });

    await online.dispose();
  });

  it("deletes the database when the storage version changes", async () => {
    const fs = createFileSystem(mode);
    const first = await createDb(fs, "a", { storageVersion: "1" });
    addTodo(first, "1", "Old layout");
    await first.dispose();

    const sameVersion = await createDb(fs, "a", { storageVersion: "1" });
    expect(todoTitles(sameVersion)).toEqual(["Old layout"]);
    await sameVersion.dispose();
    expect(fs.deleted).toEqual([]);

    const newVersion = await createDb(fs, "a", { storageVersion: "2" });
    expect(fs.deleted).toEqual(["a"]);
    expect(todoTitles(newVersion)).toEqual([]);
    await newVersion.dispose();
  });

  it("deletes the database and notifies subscribers on a clean reload", async () => {
    const fs = createFileSystem(mode);
    const db = await createDb(fs, "a");
    addTodo(db, "1", "Wiped");
    const onReload = vi.fn();
    db.subscribe("reload-requested", (event) => onReload(event.payload.clean));

    await db.requestReload({ clean: true });

    expect(fs.deleted).toEqual(["a"]);
    expect(onReload).toHaveBeenCalledWith(true);

    const reopened = await createDb(fs, "a");
    expect(todoTitles(reopened)).toEqual([]);
    await reopened.dispose();
  });

  it("rolls back a failed transaction without emitting events", async () => {
    const fs = createFileSystem(mode);
    const server = createFakeServer();
    const db = await createDb(fs, "a", { server });

    expect(() =>
      db.db.executeTransaction((tx) => {
        tx.execute({ sql: `INSERT INTO "todo" ("id", "title") VALUES (?, ?)`, parameters: ["1", "Rolled back"] });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    addTodo(db, "2", "Committed");

    await vi.waitFor(() => expect(server.events).toHaveLength(1));
    expect(server.events[0]).toMatchObject({ item_id: "2" });
    expect(todoTitles(db)).toEqual(["Committed"]);

    await db.dispose();
  });
});
