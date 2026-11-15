import { afterEach, describe, expect, it, vi } from "vitest";
import { HLCCounter } from "../src/hlc";
import { createLocalSyncedDb } from "../src/local/local-synced-db";
import { createMemoryDb } from "../src/memory-db/memory-db";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";
import {
  type SnapshotPageLimits,
  type SnapshotPullRequest,
  type SnapshotPullResponse,
  SnapshotRequiredError,
} from "../src/sqlite-crdt/crdt-snapshot";
import { createCrdtStorageMutator } from "../src/sqlite-crdt/crdt-storage-mutator";
import {
  type CrdtSyncRemoteSource,
  type CreateRemoteSourceFactory,
  createCrdtSyncRemoteSource,
  type EventsAvailable,
  type EventsPullRequest,
} from "../src/sqlite-crdt/crdt-sync-remote-source";
import { createStoredValue } from "../src/sqlite-crdt/stored-value";
import type { SqliteDriver } from "../src/sqlite-driver";
import { createKvStateHashStore, createSQLiteKvStore, STATE_HASH_KV_KEY } from "../src/sqlite-kv-store";
import { createWasmSqliteDriver, loadSqliteWasm } from "../src/wasm-driver";
import type { EventsPullResponse } from "../src/worker-db/worker-common";

const schema = defineSyncSchema({
  tables: {
    todo: t.table({
      title: t.text(),
      completed: t.boolean(),
    }),
    note: t.table({
      body: t.text(),
    }),
    counter: t.table({
      value: t.integer(),
    }),
  },
  migrations: createMigrations((b) => ({
    0: [
      b.createTable("_todo", (table) =>
        table
          .addColumn("id", "text", (col) => col.primaryKey().notNull())
          .addColumn("title", "text", (col) => col.notNull())
          .addColumn("completed", "boolean", (col) => col.notNull())
          .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
      ),
      b.createTable("_note", (table) =>
        table
          .addColumn("id", "text", (col) => col.primaryKey().notNull())
          .addColumn("body", "text", (col) => col.notNull())
          .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
      ),
      b.createTable("_counter", (table) =>
        table
          .addColumn("id", "text", (col) => col.primaryKey().notNull())
          .addColumn("value", "integer", (col) => col.notNull())
          .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
      ),
    ],
  })),
});

const PULL_LIMIT = 50;

// Every reading of the clock is later than the one before, so HLCs follow the order of the writes.
let now = 1_700_000_000_000;

type Node = Awaited<ReturnType<typeof createNode>>;

async function createNode(nodeId: string, clock: () => number = () => ++now) {
  const reactiveDb = await createSQLiteReactiveDb<unknown>({ snapshot: new Uint8Array(), logger: () => {} });
  const db = reactiveDb.db;

  db.execute(`CREATE TABLE "kv" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL) WITHOUT ROWID`);
  const kvStore = createSQLiteKvStore({ db, metaTableName: "kv" });
  const migrator = createMigrator({
    migrations: schema.migrations,
    schemaVersion: createStoredValue({ initialValue: -1 }),
  });
  migrator.migrateDbToLatest({
    startTransaction: (callback) =>
      db.executeTransaction((tx) =>
        callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
      ),
  });

  const { crdtStorage: storage } = await createMemoryDb({
    nodeId,
    migrator,
    reactiveDb,
    hlcCounter: new HLCCounter(nodeId, clock),
    crdtTables: schema.tablesConfig,
    syncDbSchema: schema,
    stateHash: createKvStateHashStore(kvStore),
  });

  const rows = (sql: string) => db.execute<Record<string, unknown>>(sql).rows;

  return {
    nodeId,
    db,
    storage,
    migrator,
    pullSyncId: createStoredValue({ initialValue: -1 }),
    todos: () => rows(`SELECT * FROM "_todo" ORDER BY "id"`),
    visibleTodos: () => rows(`SELECT * FROM "todo" ORDER BY "id"`),
    notes: () => rows(`SELECT * FROM "_note" ORDER BY "id"`),
    counters: () => rows(`SELECT *, typeof("value") AS "type" FROM "_counter" ORDER BY "id"`),
    updateLog: () => rows(`SELECT * FROM "crdt_update_log" ORDER BY "dataset", "item_id"`),
    stateHash: () => kvStore.get(STATE_HASH_KV_KEY),
    dataEvents: () => rows(`SELECT * FROM "persisted_crdt_events" WHERE "payload" <> 'no-op' ORDER BY "sync_id"`),
    addTodo: (id: string, title: string) =>
      db.execute({ sql: `INSERT INTO "todo" ("id", "title", "completed") VALUES (?, ?, 0)`, parameters: [id, title] }),
    setTitle: (id: string, title: string) =>
      db.execute({ sql: `UPDATE "todo" SET "title" = ? WHERE "id" = ?`, parameters: [title, id] }),
    setCompleted: (id: string, completed: boolean) =>
      db.execute({ sql: `UPDATE "todo" SET "completed" = ? WHERE "id" = ?`, parameters: [Number(completed), id] }),
    deleteTodo: (id: string) => db.execute({ sql: `DELETE FROM "todo" WHERE "id" = ?`, parameters: [id] }),
    addNote: (id: string, body: string) =>
      db.execute({ sql: `INSERT INTO "note" ("id", "body") VALUES (?, ?)`, parameters: [id, body] }),
  };
}

type LinkOptions = {
  limits?: SnapshotPageLimits;
  /** Leaves `pullSnapshot` out, like a remote source written before snapshots existed. */
  withoutSnapshot?: boolean;
  pullEvents?: (request: EventsPullRequest) => EventsPullResponse;
  pullSnapshot?: (request: SnapshotPullRequest, pull: () => SnapshotPullResponse) => SnapshotPullResponse;
};

/** Serves one node's storage to another, the way a server or a worker does. */
function serve(upstream: Node, opts: LinkOptions = {}) {
  const pulls: EventsPullRequest[] = [];
  const snapshotRequests: SnapshotPullRequest[] = [];
  const listeners = new Set<(event: EventsAvailable) => void>();
  let lastBroadcast: EventsAvailable | null = null;

  upstream.storage.addEventListener("events-applied", (event) => {
    lastBroadcast = { newSyncId: event.payload.syncId, remoteStateHash: event.payload.stateHash };
    for (const listener of listeners) {
      listener(lastBroadcast);
    }
  });

  const factory: CreateRemoteSourceFactory = ({ onEventsAvailable }) => {
    listeners.add(onEventsAvailable);
    return {
      pullEvents: async (request) => {
        pulls.push(request);
        return opts.pullEvents?.(request) ?? upstream.storage.pullEvents({ ...request, limit: PULL_LIMIT });
      },
      pushEvents: async (request) => {
        const { beforeSyncId, afterSyncId } = upstream.storage.enqueueLocalEvents(request.events, request.nodeId);
        return { ok: true, beforeSyncId, afterSyncId };
      },
      pullSnapshot: opts.withoutSnapshot
        ? undefined
        : async (request) => {
            snapshotRequests.push(request);
            const pull = () => upstream.storage.getSnapshotPage(request, opts.limits);
            return opts.pullSnapshot ? opts.pullSnapshot(request, pull) : pull();
          },
      disconnect: () => {
        listeners.delete(onEventsAvailable);
      },
    };
  };

  return {
    factory,
    pulls,
    snapshotRequests,
    /** Repeats the last broadcast, which makes caught-up nodes compare state hashes. */
    rebroadcast: () => {
      if (lastBroadcast) {
        for (const listener of listeners) {
          listener(lastBroadcast);
        }
      }
    },
  };
}

describe("snapshot bootstrap", () => {
  const remoteSources: CrdtSyncRemoteSource[] = [];
  const deSyncs: string[] = [];

  afterEach(async () => {
    await Promise.all(remoteSources.splice(0).map((remoteSource) => remoteSource.dispose()));
    deSyncs.splice(0);
    vi.restoreAllMocks();
  });

  const connect = (
    node: Node,
    remoteFactory: CreateRemoteSourceFactory,
    opts: { snapshotBootstrap?: boolean } = {},
  ) => {
    const remoteSource = createCrdtSyncRemoteSource({
      bufferSize: 75,
      storage: node.storage,
      migrator: node.migrator,
      pullSyncId: node.pullSyncId,
      pushSyncId: createStoredValue({ initialValue: 0 }),
      nodeId: node.nodeId,
      remoteFactory,
      snapshotBootstrap: opts.snapshotBootstrap,
    });
    remoteSource.addEventListener("de-sync-detected", (event) => deSyncs.push(event.payload.reason));
    remoteSources.push(remoteSource);
    void remoteSource.goOnline();
    return remoteSource;
  };

  const expectSameState = (node: Node, other: Node) => {
    expect(node.todos()).toEqual(other.todos());
    expect(node.notes()).toEqual(other.notes());
    expect(node.counters()).toEqual(other.counters());
    expect(node.updateLog()).toEqual(other.updateLog());
    expect(node.stateHash()).toBe(other.stateHash());
  };

  const waitForSameState = (node: Node, other: Node) =>
    vi.waitFor(() => expectSameState(node, other), { timeout: 5000 });

  /** Many more events than rows: every todo is edited, some are deleted and one is restored. */
  const fillServer = async (server: Node, count = 120) => {
    server.db.executeTransaction(() => {
      for (let i = 0; i < count; i++) {
        const id = `todo-${String(i).padStart(4, "0")}`;
        server.addTodo(id, `Todo ${i}`);
        server.setTitle(id, `Todo ${i} edited`);
        if (i % 3 === 0) {
          server.setCompleted(id, true);
        }
        if (i % 10 === 0) {
          server.deleteTodo(id);
        }
      }
      for (let i = 0; i < 5; i++) {
        server.addNote(`note-${i}`, `Note ${i}`);
      }
    });
    createCrdtStorageMutator<{ _todo: { id: string; title: string; completed: boolean } }>({
      storage: server.storage,
    }).applySnapshot({ dataset: "_todo", id: "todo-0000", patch: { title: "Restored" } });
    await vi.waitFor(() => expect(server.storage.checkIsQuiescent(Number.MAX_SAFE_INTEGER)).toBe(true));
  };

  it("starts a node that has not synced from a snapshot instead of the event history", async () => {
    const server = await createNode("server");
    await fillServer(server);
    expect(server.dataEvents().length).toBeGreaterThan(250);

    const client = await createNode("client");
    const link = serve(server);
    connect(client, link.factory);

    await waitForSameState(client, server);
    expect(client.todos()).toHaveLength(120);
    expect(client.dataEvents()).toEqual([]);
    expect(link.snapshotRequests).toEqual([{ cursor: null }]);
    expect(link.pulls[0]).toMatchObject({ afterSyncId: -1, acceptSnapshot: true });

    server.setTitle("todo-0001", "Edited after the snapshot");
    await waitForSameState(client, server);
    expect(client.dataEvents()).toHaveLength(1);

    link.rebroadcast();
    expect(deSyncs).toEqual([]);
  });

  it("ends in the state that replaying the events ends in", async () => {
    const server = await createNode("server");
    await fillServer(server);

    const fromSnapshot = await createNode("from-snapshot");
    const fromEvents = await createNode("from-events");
    const link = serve(server, { limits: { maxItems: 25 } });
    connect(fromSnapshot, link.factory);
    connect(fromEvents, link.factory, { snapshotBootstrap: false });

    await waitForSameState(fromSnapshot, server);
    await waitForSameState(fromEvents, server);
    expectSameState(fromSnapshot, fromEvents);
    expect(fromEvents.dataEvents().length).toBeGreaterThan(250);
    expect(link.snapshotRequests.length).toBeGreaterThan(4);
    expect(link.pulls.filter((pull) => pull.excludeNodeId === "from-events")).not.toContainEqual(
      expect.objectContaining({ acceptSnapshot: true }),
    );
  });

  it("carries values over a JSON connection as events do", async () => {
    const overJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));
    const server = await createNode("server");
    await fillServer(server);
    server.db.execute(`INSERT INTO "counter" ("id", "value") VALUES ('beyond-double', 9007199254740993)`);
    server.db.execute(`INSERT INTO "counter" ("id", "value") VALUES ('infinite', 9e999)`);
    server.addNote("nul", "a\u0000b");

    const replayed = await createNode("replayed");
    const replayLink = serve(server, {
      pullEvents: (request) => overJson(server.storage.pullEvents({ ...request, limit: PULL_LIMIT })),
    });
    connect(replayed, replayLink.factory, { snapshotBootstrap: false });
    const client = await createNode("client");
    connect(client, serve(server, { pullSnapshot: (_request, pull) => overJson(pull()) }).factory);

    await waitForSameState(replayed, server);
    await waitForSameState(client, replayed);
    expect(client.dataEvents()).toEqual([]);
    expect(client.counters()).toContainEqual(expect.objectContaining({ id: "infinite", value: Infinity }));
    expect(client.notes()).toContainEqual(expect.objectContaining({ id: "nul", body: "a\u0000b" }));
  });

  it("keeps replaying events from a small remote", async () => {
    const server = await createNode("server");
    server.addTodo("1", "Only todo");

    const client = await createNode("client");
    const link = serve(server);
    connect(client, link.factory);

    await waitForSameState(client, server);
    expect(link.snapshotRequests).toEqual([]);
    expect(client.dataEvents()).toHaveLength(1);
  });

  it("replays events when the remote source cannot pull snapshots", async () => {
    const server = await createNode("server");
    await fillServer(server);

    const client = await createNode("client");
    const link = serve(server, { withoutSnapshot: true });
    connect(client, link.factory);

    await waitForSameState(client, server);
    expect(link.pulls).not.toContainEqual(expect.objectContaining({ acceptSnapshot: true }));
  });

  it("keeps writes made before the first sync and pushes them", async () => {
    const server = await createNode("server");
    await fillServer(server);

    const client = await createNode("client");
    client.addTodo("local-1", "Written offline");
    const link = serve(server);
    connect(client, link.factory);

    await waitForSameState(client, server);
    expect(server.todos()).toContainEqual(expect.objectContaining({ id: "local-1", title: "Written offline" }));
    expect(link.snapshotRequests).toHaveLength(1);

    link.rebroadcast();
    expect(deSyncs).toEqual([]);
  });

  it("converges when the remote changes while the snapshot is pulled", async () => {
    const server = await createNode("server");
    await fillServer(server);

    let page = 0;
    const link = serve(server, {
      limits: { maxItems: 20 },
      pullSnapshot: (_request, pull) => {
        const response = pull();
        page++;
        if (page === 2) {
          server.setTitle("todo-0005", "Changed in a page already sent");
          server.setTitle("todo-0100", "Changed in a page not sent yet");
          server.addTodo("todo-0002-new", "Added behind the cursor");
          server.addTodo("todo-9999", "Added ahead of the cursor");
          server.deleteTodo("todo-0007");
          server.addNote("note-9", "Added to a table not reached yet");
        }
        return response;
      },
    });
    const client = await createNode("client");
    connect(client, link.factory);

    await waitForSameState(client, server);
    expect(page).toBeGreaterThan(5);
    expect(client.todos()).toContainEqual(expect.objectContaining({ id: "todo-0002-new" }));

    link.rebroadcast();
    expect(deSyncs).toEqual([]);
  });

  it("continues an unfinished snapshot on the next connection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);

    let failed = false;
    const link = serve(server, {
      limits: { maxItems: 20 },
      pullSnapshot: (_request, pull) => {
        if (link.snapshotRequests.length === 3 && !failed) {
          failed = true;
          throw new Error("Connection lost");
        }
        return pull();
      },
    });
    const client = await createNode("client");
    const remoteSource = connect(client, link.factory);

    await vi.waitFor(() => expect(failed).toBe(true));
    await vi.waitFor(() => expect(remoteSource.getState().remoteState).not.toBe("online"));
    expect(client.todos()).toHaveLength(40);
    expect(client.pullSyncId.current).toBe(-1);

    await remoteSource.syncWithRemote();
    await waitForSameState(client, server);

    const [, second, failedRequest, resumed] = link.snapshotRequests;
    expect(second.cursor).not.toBeNull();
    expect(failedRequest.cursor).not.toEqual(second.cursor);
    expect(resumed).toEqual(failedRequest);
    expect(link.snapshotRequests.filter((request) => request.cursor === null)).toHaveLength(1);
  });

  it("replays events when the snapshot is for another schema version", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);

    const link = serve(server, {
      pullSnapshot: (_request, pull) => ({ ...pull(), schemaVersion: -1 }),
    });
    const client = await createNode("client");
    connect(client, link.factory);

    await waitForSameState(client, server);
    expect(link.snapshotRequests).toHaveLength(1);
    expect(client.dataEvents().length).toBeGreaterThan(250);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Replaying events instead"), expect.anything());
  });

  it("merges cell by cell into items the node already has", async () => {
    const a = await createNode("a");
    const b = await createNode("b");

    a.addTodo("1", "Created on A");
    await vi.waitFor(() => expect(a.storage.checkIsQuiescent(Number.MAX_SAFE_INTEGER)).toBe(true));
    b.storage.mergeSnapshotItems(a.storage.getSnapshotPage({ cursor: null }).items);
    expectSameState(b, a);

    a.setTitle("1", "Older title from A");
    b.setTitle("1", "Newer title from B");
    a.setCompleted("1", true);
    b.addTodo("2", "Only on B");

    b.storage.mergeSnapshotItems(a.storage.getSnapshotPage({ cursor: null }).items);
    expect(b.todos()).toEqual([
      { id: "1", title: "Newer title from B", completed: 1, tombstone: 0 },
      { id: "2", title: "Only on B", completed: 0, tombstone: 0 },
    ]);

    a.storage.mergeSnapshotItems(b.storage.getSnapshotPage({ cursor: null }).items);
    expectSameState(a, b);

    const before = { updateLog: b.updateLog(), stateHash: b.stateHash() };
    b.storage.mergeSnapshotItems(a.storage.getSnapshotPage({ cursor: null }).items);
    expect({ updateLog: b.updateLog(), stateHash: b.stateHash() }).toEqual(before);
  });

  it("gives writes made after a merge a later HLC than the merged cells, even with a clock that is behind", async () => {
    const a = await createNode("a");
    a.addTodo("1", "From A");

    const b = await createNode("b", () => 1000);
    b.storage.mergeSnapshotItems(a.storage.getSnapshotPage({ cursor: null }).items);

    b.setTitle("1", "Edited on B");
    a.storage.mergeSnapshotItems(b.storage.getSnapshotPage({ cursor: null }).items);
    expect(a.todos()).toEqual([{ id: "1", title: "Edited on B", completed: 0, tombstone: 0 }]);
  });

  it("passes a merged snapshot on to nodes that already pulled from this one", async () => {
    const server = await createNode("server");
    await fillServer(server);

    const worker = await createNode("worker");
    const tab = await createNode("tab");
    const workerLink = serve(worker);
    connect(tab, workerLink.factory);
    await vi.waitFor(() => expect(workerLink.pulls).toHaveLength(1));
    expect(tab.todos()).toEqual([]);

    const serverLink = serve(server);
    connect(worker, serverLink.factory);

    await waitForSameState(worker, server);
    await waitForSameState(tab, server);
    expect(workerLink.snapshotRequests).toEqual([{ cursor: null }]);
    expect(tab.dataEvents()).toEqual([]);

    tab.setTitle("todo-0001", "Edited in the tab");
    await waitForSameState(server, tab);
    server.setTitle("todo-0002", "Edited on the server");
    await waitForSameState(tab, server);

    serverLink.rebroadcast();
    expect(deSyncs).toEqual([]);
  });

  it("serves no events to other nodes while its snapshot is unfinished", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);

    const worker = await createNode("worker");
    const tab = await createNode("tab");
    const workerLink = serve(worker);
    connect(tab, workerLink.factory);
    await vi.waitFor(() => expect(workerLink.pulls).toHaveLength(1));

    let failed = false;
    const serverLink = serve(server, {
      limits: { maxItems: 20 },
      pullSnapshot: (_request, pull) => {
        if (serverLink.snapshotRequests.length === 3 && !failed) {
          failed = true;
          throw new Error("Connection lost");
        }
        return pull();
      },
    });
    const workerSource = connect(worker, serverLink.factory);
    await vi.waitFor(() => expect(failed).toBe(true));
    await vi.waitFor(() => expect(workerSource.getState().remoteState).not.toBe("online"));

    // What a tab opened after the first pages can push: an edit of a row the first tab does not have.
    worker.setTitle("todo-0001", "Edited during the snapshot");
    await vi.waitFor(() => expect(workerLink.pulls.length).toBeGreaterThan(1));
    expect(tab.dataEvents()).toEqual([]);

    await workerSource.syncWithRemote();
    await waitForSameState(worker, server);
    await waitForSameState(tab, server);
    expect(deSyncs).toEqual([]);
  });

  it("serves other nodes again after giving up a snapshot part way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);

    const worker = await createNode("worker");
    const tab = await createNode("tab");
    connect(tab, serve(worker).factory);

    const serverLink = serve(server, {
      limits: { maxItems: 20 },
      pullSnapshot: (_request, pull) =>
        serverLink.snapshotRequests.length === 3 ? { ...pull(), schemaVersion: -1 } : pull(),
    });
    connect(worker, serverLink.factory);

    await waitForSameState(worker, server);
    expect(worker.dataEvents().length).toBeGreaterThan(250);
    await waitForSameState(tab, server);
    expect(deSyncs).toEqual([]);
  });

  it("does not compare state with a node that opened while the snapshot was unfinished", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);

    const failAt = [3, 5];
    const serverLink = serve(server, {
      limits: { maxItems: 20 },
      pullSnapshot: (_request, pull) => {
        if (serverLink.snapshotRequests.length === failAt[0]) {
          failAt.shift();
          throw new Error("Connection lost");
        }
        return pull();
      },
    });
    const worker = await createNode("worker");
    const workerSource = connect(worker, serverLink.factory);
    await vi.waitFor(() => expect(failAt).toEqual([5]));
    await vi.waitFor(() => expect(workerSource.getState().remoteState).not.toBe("online"));

    // A tab starts from a copy of the worker's database.
    const tab = await createNode("tab");
    tab.storage.mergeSnapshotItems(worker.storage.getSnapshotPage({ cursor: null }).items);
    tab.pullSyncId.current = worker.storage.getSnapshotPage({ cursor: null }).syncId;
    expect(tab.stateHash()).toBe(worker.stateHash());

    await workerSource.syncWithRemote().catch(() => {});
    await vi.waitFor(() => expect(failAt).toEqual([]));
    await vi.waitFor(() => expect(workerSource.getState().remoteState).not.toBe("online"));
    expect(worker.todos().length).toBeGreaterThan(tab.todos().length);

    const workerLink = serve(worker);
    const tabSource = connect(tab, workerLink.factory);
    await tabSource.catchUp();
    tab.setTitle("todo-0001", "Edited in the tab");
    await vi.waitFor(() =>
      expect(worker.todos()).toContainEqual(expect.objectContaining({ title: "Edited in the tab" })),
    );
    await tabSource.catchUp();
    workerLink.rebroadcast();
    expect(deSyncs).toEqual([]);

    await workerSource.syncWithRemote();
    await waitForSameState(worker, server);
    await waitForSameState(tab, server);
    workerLink.rebroadcast();
    expect(deSyncs).toEqual([]);
  });

  it("does not fall back to events when a required snapshot cannot be merged", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);
    const worker = await createNode("worker");
    connect(worker, serve(server).factory);
    await waitForSameState(worker, server);

    const tab = await createNode("tab");
    tab.pullSyncId.current = 0;
    const link = serve(worker, { pullSnapshot: (_request, pull) => ({ ...pull(), schemaVersion: 1 }) });
    const remoteSource = connect(tab, link.factory);

    await expect(remoteSource.catchUp()).resolves.toMatchObject({ pulled: false });
    expect(remoteSource.getState().schemaVersionMismatched).toBe(true);
    expect(link.snapshotRequests).toHaveLength(1);
    expect(link.pulls).toEqual([{ afterSyncId: 0, excludeNodeId: "tab", acceptSnapshot: true }]);
    expect(tab.todos()).toEqual([]);
  });

  it("stops when the remote keeps asking for a snapshot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await createNode("server");
    const link = serve(server, {
      pullEvents: ({ afterSyncId }) => ({ events: [], hasMore: true, nextSyncId: afterSyncId, snapshot: "required" }),
    });
    const client = await createNode("client");
    const remoteSource = connect(client, link.factory);

    await expect(remoteSource.catchUp()).resolves.toMatchObject({ pulled: false });
    expect(link.snapshotRequests).toHaveLength(3);
  });

  it("continues an unfinished snapshot after the database is reopened", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const server = await createNode("server");
    await fillServer(server);

    let file: Uint8Array<ArrayBufferLike> | undefined;
    const openDriver = async (): Promise<SqliteDriver> => {
      const sqlite3 = await loadSqliteWasm();
      const driver = createWasmSqliteDriver(sqlite3, new sqlite3.oo1.DB({ filename: ":memory:" }));
      if (file) {
        driver.deserialize?.(file);
      }
      return {
        ...driver,
        close: () => {
          file = driver.serialize?.();
          driver.close();
        },
      };
    };
    const open = (createRemoteSource: CreateRemoteSourceFactory) =>
      createLocalSyncedDb({
        dbId: "snapshot-test",
        syncDbSchema: schema,
        openDriver,
        deleteDatabase: () => {},
        createRemoteSource,
        logger: () => {},
      });
    const visibleTodos = (db: Awaited<ReturnType<typeof open>>) =>
      db.db.execute<Record<string, unknown>>(`SELECT * FROM "todo" ORDER BY "id"`).rows;

    let failed = false;
    const failing = serve(server, {
      limits: { maxItems: 20 },
      pullSnapshot: (_request, pull) => {
        if (failing.snapshotRequests.length >= 3) {
          failed = true;
          throw new Error("Connection lost");
        }
        return pull();
      },
    });
    const first = await open(failing.factory);
    await vi.waitFor(() => expect(failed).toBe(true));
    await first.dispose();

    const link = serve(server, { limits: { maxItems: 20 } });
    const second = await open(link.factory);
    await expect(second.state.catchUp()).resolves.toEqual({ pulled: true, pushed: true, timedOut: false });

    expect(link.snapshotRequests[0]).toEqual(failing.snapshotRequests[2]);
    expect(link.snapshotRequests[0].cursor).not.toBeNull();
    expect(visibleTodos(second)).toEqual(server.visibleTodos());

    const deSynced = vi.fn();
    second.subscribe("de-sync-detected", deSynced);
    link.rebroadcast();
    expect(deSynced).not.toHaveBeenCalled();
    expect(second.state.getState()).toMatchObject({ remoteState: "online", deSynced: false });
    await second.dispose();
  });

  it("refuses to serve events from before a merged snapshot", async () => {
    const server = await createNode("server");
    await fillServer(server);
    const worker = await createNode("worker");
    connect(worker, serve(server).factory);
    await waitForSameState(worker, server);

    expect(() => worker.storage.pullEvents({ afterSyncId: 0, limit: PULL_LIMIT })).toThrow(SnapshotRequiredError);
    expect(worker.storage.pullEvents({ afterSyncId: 0, limit: PULL_LIMIT, acceptSnapshot: true })).toEqual({
      events: [],
      hasMore: true,
      nextSyncId: 0,
      snapshot: "required",
    });
  });
});
