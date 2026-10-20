import { createMigrations, defineSyncSchema, t } from "@sqlite-sync/core";
import type { CreateRemoteSourceFactory } from "@sqlite-sync/core/local";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeOpSqlite, loadFakeOpSqlite } from "./fake-op-sqlite";

const fakeOpSqlite = vi.hoisted(() => ({ current: null as ReturnType<typeof createFakeOpSqlite> | null }));
const appState = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
}));

vi.mock("@op-engineering/op-sqlite", () => ({
  open: (options: { name: string; location?: string }) => {
    if (!fakeOpSqlite.current) {
      throw new Error("fake op-sqlite is not set up");
    }
    return fakeOpSqlite.current.open(options);
  },
}));

vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_type: "change", listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

const { createSyncedDb } = await import("../src/create-synced-db");
const { createOpSqliteDriver } = await import("../src/op-sqlite-driver");

const schema = defineSyncSchema({
  tables: {
    todo: t.table({ title: t.text() }),
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

type PushedEvent = { item_id: string; source_node_id: string; sync_id: number };

function createFakeServer() {
  const events: (Record<string, unknown> & PushedEvent)[] = [];
  let connections = 0;
  const createRemoteSource: CreateRemoteSourceFactory = () => {
    connections++;
    return {
      pullEvents: async ({ afterSyncId, excludeNodeId }) => {
        const page = events.filter((event) => event.sync_id > afterSyncId);
        return {
          events: page
            .filter((event) => event.source_node_id !== excludeNodeId)
            .map(({ sync_id: _syncId, source_node_id: _sourceNodeId, ...event }) => event as never),
          hasMore: false,
          nextSyncId: page.at(-1)?.sync_id ?? afterSyncId,
        };
      },
      pushEvents: async ({ nodeId, events: pushed }) => {
        const beforeSyncId = events.length;
        for (const event of pushed) {
          events.push({ ...event, sync_id: events.length + 1, source_node_id: nodeId });
        }
        return { ok: true, beforeSyncId, afterSyncId: events.length };
      },
    };
  };
  return { events, createRemoteSource, connections: () => connections };
}

const quietLogger = () => {};

beforeAll(async () => {
  await loadFakeOpSqlite();
});

afterEach(() => {
  fakeOpSqlite.current = null;
  appState.listeners.clear();
});

const setUp = () => {
  const fake = createFakeOpSqlite();
  fakeOpSqlite.current = fake;
  return fake;
};

describe("createOpSqliteDriver", () => {
  it("explains how to enable bytecode virtual tables when they are missing", () => {
    const db = {
      executeRawSync: () => {
        throw new Error("no such table: tables_used");
      },
    };
    expect(() => createOpSqliteDriver(db as never)).toThrow(/SQLITE_ENABLE_BYTECODE_VTAB/);
  });

  it("maps op-sqlite values to driver values", () => {
    const fake = setUp();
    const driver = createOpSqliteDriver(fake.open({ name: "values.sqlite" }) as never);

    const { columns, rows } = driver
      .prepare("select ? as blob, ? as flag, ? as big, ? as missing")
      .run([new Uint8Array([1, 2, 3]), true, 42n, undefined]);

    expect(columns).toEqual(["blob", "flag", "big", "missing"]);
    expect(rows).toEqual([[new Uint8Array([1, 2, 3]), 1, 42, null]]);
    expect(() => driver.prepare("select ?").run([2n ** 60n])).toThrow(/binds numbers as doubles/);
    driver.close();
  });
});

describe("createSyncedDb", () => {
  it("persists writes, pushes them, and keeps them across restarts", async () => {
    const fake = setUp();
    const server = createFakeServer();
    const db = await createSyncedDb({
      dbId: "todos",
      syncDbSchema: schema,
      createRemoteSource: server.createRemoteSource,
      logger: quietLogger,
    });

    db.db.execute({ sql: `INSERT INTO "todo" ("id", "title") VALUES (?, ?)`, parameters: ["1", "Ship RN"] });

    await vi.waitFor(() => expect(server.events.map((event) => event.item_id)).toEqual(["1"]));
    await db.dispose();
    expect([...fake.files.keys()]).toEqual(["default/todos.sqlite"]);

    const reopened = await createSyncedDb({
      dbId: "todos",
      syncDbSchema: schema,
      createRemoteSource: server.createRemoteSource,
      logger: quietLogger,
    });
    expect(reopened.db.execute<{ title: string }>(`SELECT "title" FROM "todo"`).rows).toEqual([{ title: "Ship RN" }]);
    await reopened.dispose();
  });

  it("applies remote events and notifies live queries", async () => {
    setUp();
    const server = createFakeServer();
    server.events.push({
      sync_id: 1,
      source_node_id: "other-device",
      schema_version: 0,
      type: "item-created",
      dataset: "_todo",
      item_id: "remote-1",
      payload: JSON.stringify({ id: "remote-1", title: "From the server" }),
      timestamp: "1729300000000:0000000001:other-device",
    });

    const db = await createSyncedDb({
      dbId: "todos",
      syncDbSchema: schema,
      createRemoteSource: server.createRemoteSource,
      logger: quietLogger,
    });
    const liveQuery = db.db.getSharedLiveQuery<{ title: string }>({
      sql: `SELECT "title" FROM "todo"`,
      parameters: [],
    });
    const unsubscribe = liveQuery.subscribe(() => {});

    await vi.waitFor(() => expect(liveQuery.getRows()).toEqual([{ title: "From the server" }]));

    unsubscribe();
    await db.dispose();
  });

  it("syncs on foreground, drops the connection on background, and stops listening once disposed", async () => {
    setUp();
    const db = await createSyncedDb({ dbId: "todos", syncDbSchema: schema, logger: quietLogger });
    const sync = vi.spyOn(db.state, "sync");
    const dropConnection = vi.spyOn(db.state, "dropConnection");
    expect(appState.listeners.size).toBe(1);

    for (const listener of appState.listeners) listener("background");
    for (const listener of appState.listeners) listener("active");

    expect(dropConnection).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);

    await db.requestReload({ clean: false });
    expect(appState.listeners.size).toBe(0);
  });

  it("deletes the database file on a clean reload", async () => {
    const fake = setUp();
    const db = await createSyncedDb({ dbId: "todos", syncDbSchema: schema, logger: quietLogger });
    db.db.execute({ sql: `INSERT INTO "todo" ("id", "title") VALUES (?, ?)`, parameters: ["1", "Gone"] });
    const onReload = vi.fn();
    db.subscribe("reload-requested", (event) => onReload(event.payload.clean));

    await db.requestReload({ clean: true });

    expect(fake.deleted).toEqual(["default/todos.sqlite"]);
    expect(onReload).toHaveBeenCalledWith(true);
  });

  it("verifies the schema on an in-memory database", async () => {
    const fake = setUp();
    const db = await createSyncedDb({ dbId: "todos", syncDbSchema: schema, verifySchema: true, logger: quietLogger });
    await db.dispose();
    expect([...fake.files.keys()]).toEqual(["default/todos.sqlite"]);
  });
});
