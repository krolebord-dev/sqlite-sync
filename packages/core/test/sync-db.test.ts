import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";
import { createMigrations } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";
import { createSyncedDb, createSyncedDbDatabase, type SyncedDb } from "../src/sync-db";
import { createDeferredPromise } from "../src/utils";
import { runWithNoActiveReplicas } from "../src/worker-db/replica-lock";
import { createBroadcastChannels, type WorkerResponseMessage } from "../src/worker-db/worker-common";

describe.runIf(globalThis.navigator?.locks)("SyncedDb initialization cleanup", () => {
  const schema = defineSyncSchema({
    tables: { todo: t.table({ title: t.text() }) },
    migrations: createMigrations(() => ({ 0: [] })),
  });

  let dbId: string;
  let close: MockInstance<BroadcastChannel["close"]>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    close = vi.spyOn(BroadcastChannel.prototype, "close");
    dbId = `sync-test-${crypto.randomUUID()}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const createWorker = (postMessage: () => void) =>
    Object.assign(new EventTarget(), {
      onerror: null,
      onmessage: null,
      onmessageerror: null,
      postMessage: vi.fn(postMessage),
      terminate: vi.fn(),
    }) satisfies Worker;

  const expectReleased = async () => {
    const { held, pending } = await navigator.locks.query();
    expect(held?.some((lock) => lock.name.endsWith(dbId))).toBe(false);
    expect(pending?.some((lock) => lock.name.endsWith(dbId))).toBe(false);
    expect(close.mock.contexts).toHaveLength(2);
    for (const channel of close.mock.contexts) {
      expect(() => channel.postMessage("closed")).toThrow();
    }
    expect(vi.getTimerCount()).toBe(0);
  };

  it("releases resources when posting the worker config fails", async () => {
    const error = new DOMException("Worker props cannot be cloned", "DataCloneError");
    const worker = createWorker(() => {
      throw error;
    });
    await expect(createSyncedDb({ dbId, worker, syncDbSchema: schema })).rejects.toBe(error);
    await expectReleased();
  });

  it("releases resources and pending requests when the worker state times out", async () => {
    const started = createDeferredPromise<void>();
    const worker = createWorker(() => started.resolve());
    const rejected = expect(createSyncedDb({ dbId, worker, syncDbSchema: schema })).rejects.toThrow(
      "Promise timed out after 15000ms",
    );
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    await expectReleased();
  });

  it("rejects and closes channels when the client lock request fails", async () => {
    const error = new Error("Client lock unavailable");
    vi.spyOn(navigator.locks, "request").mockRejectedValueOnce(error);
    const worker = createWorker(() => {});
    await expect(createSyncedDb({ dbId, worker, syncDbSchema: schema })).rejects.toBe(error);
    expect(worker.postMessage).not.toHaveBeenCalled();
    await expectReleased();
  });

  it("disposes the initialized worker client when the replica lock request fails", async () => {
    const channels = createBroadcastChannels(dbId);
    const error = new Error("Replica lock unavailable");
    const requestLock = navigator.locks.request.bind(navigator.locks);
    vi.spyOn(navigator.locks, "request").mockImplementationOnce(requestLock).mockRejectedValueOnce(error);
    const worker = createWorker(() =>
      channels.responses.postMessage({
        notificationType: "state-changed",
        state: { remoteState: "offline", deSynced: false, schemaVersionMismatched: false },
        storageGeneration: "gen-1",
      }),
    );
    try {
      await expect(createSyncedDb({ dbId, worker, syncDbSchema: schema })).rejects.toBe(error);
      expect(worker.postMessage).toHaveBeenCalledOnce();
      await expectReleased();
    } finally {
      channels.requests.close();
      channels.responses.close();
    }
  });
});

describe("SyncedDb database facade", () => {
  it("drains through normal execution and bypasses only through unsafe execution", async () => {
    const reactiveDb = await createSQLiteReactiveDb<unknown>({
      snapshot: new Uint8Array(),
      logger: () => {},
    });

    try {
      reactiveDb.db.execute(`create table "item" ("id" integer primary key)`);

      let callbackCount = 0;
      reactiveDb.db.setAfterMutatingStatement(() => {
        callbackCount++;
      });

      const db = createSyncedDbDatabase(reactiveDb);
      const assertPublicTypes = () => {
        // @ts-expect-error draining can only be bypassed through db.unsafe
        db.execute(`select 1`, { skipAfterMutatingStatement: true });
        db.executeTransaction((tx) => {
          // @ts-expect-error prepared execution is not part of the public transaction facade
          tx.executePreparedRaw({ key: "unsafe", sql: "select 1" });
        });
      };
      void assertPublicTypes;

      db.execute(`insert into "item" default values`);
      db.unsafe.execute(`insert into "item" default values`);

      expect(callbackCount).toBe(1);

      db.executeTransaction((tx) => {
        expect(Object.keys(tx).sort()).toEqual(["execute", "executeKysely", "sql", "unsafe"]);
        expect(Object.keys(tx.unsafe).sort()).toEqual(["execute", "executeKysely"]);

        tx.execute(`insert into "item" default values`);
        tx.unsafe.execute(`insert into "item" default values`);
      });

      expect(callbackCount).toBe(2);
    } finally {
      reactiveDb.dispose();
    }
  });
});

describe("SyncedDb state", () => {
  it("returns immediately and delivers events pulled by the worker to the tab", async () => {
    vi.stubGlobal("navigator", {
      locks: { request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback() },
    });
    const schema = defineSyncSchema({
      tables: { todo: t.table({ title: t.text() }) },
      migrations: createMigrations(() => ({ 0: [] })),
    });
    const initialDb = await createSQLiteReactiveDb({ snapshot: new Uint8Array(), logger: () => {} });
    let syncedDb: SyncedDb<(typeof schema)["~clientSchema"]> | undefined;
    const dbId = `sync-test-${crypto.randomUUID()}`;
    const channels = createBroadcastChannels(dbId);
    try {
      initialDb.db.execute(
        "CREATE TABLE _todo (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0)",
      );
      const snapshot = initialDb.createSnapshot();
      let serverSyncDone = false;
      const respond = (requestId: string, data: WorkerResponseMessage["data"]) =>
        channels.responses.postMessage({ type: "response", requestId, data });
      const postState = () =>
        channels.responses.postMessage({
          notificationType: "state-changed",
          state: { remoteState: "online", deSynced: false, schemaVersionMismatched: false },
          storageGeneration: "gen-1",
        });
      channels.requests.onmessage = ({ data: request }) => {
        switch (request.method) {
          case "postState":
            postState();
            respond(request.requestId, undefined);
            break;
          case "getSnapshot":
            respond(request.requestId, { file: snapshot, syncId: 0, schemaVersion: 0, storageGeneration: "gen-1" });
            break;
          case "pullEvents":
            if (serverSyncDone) {
              respond(request.requestId, {
                events: [
                  {
                    schema_version: 0,
                    timestamp: "000000000000001:00000:remote",
                    type: "item-created",
                    dataset: "_todo",
                    item_id: "1",
                    payload: JSON.stringify({ id: "1", title: "From server" }),
                  },
                ],
                hasMore: false,
                nextSyncId: 1,
              });
            } else {
              respond(request.requestId, { events: [], hasMore: false, nextSyncId: 0 });
            }
            break;
          case "sync":
            serverSyncDone = true;
            channels.responses.postMessage({
              notificationType: "new-event-chunk-applied",
              newSyncId: 1,
              eventHlcSum: null,
            });
            respond(request.requestId, undefined);
            break;
          default:
            throw new Error(`Unexpected request ${request.method}`);
        }
      };
      const worker = Object.assign(new EventTarget(), {
        onerror: null,
        onmessage: null,
        onmessageerror: null,
        postMessage: vi.fn(postState),
        terminate: vi.fn(),
      }) satisfies Worker;
      syncedDb = await createSyncedDb({
        dbId,
        worker,
        syncDbSchema: schema,
      });
      expect(syncedDb.state.sync()).toBeUndefined();
      expect(syncedDb.db.execute("SELECT * FROM todo").rows).toEqual([]);
      await vi.waitFor(() =>
        expect(syncedDb?.db.execute("SELECT title FROM todo").rows).toEqual([{ title: "From server" }]),
      );
    } finally {
      await syncedDb?.dispose();
      initialDb.dispose();
      channels.requests.close();
      channels.responses.close();
      vi.unstubAllGlobals();
    }
  });
});

describe("SyncedDb storage generation", () => {
  const realLocks = globalThis.navigator?.locks;
  const setup = async (opts: {
    snapshotStorageGeneration: string;
    stateStorageGeneration: string;
    locks?: LockManager;
    beforeSnapshot?: (dbId: string) => Promise<void>;
    includeTodoTable?: boolean;
  }) => {
    vi.stubGlobal("navigator", {
      locks: opts.locks ?? { request: (_name: string, _options: unknown, callback: () => Promise<void>) => callback() },
    });
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });

    const schema = defineSyncSchema({
      tables: { todo: t.table({ title: t.text() }) },
      migrations: createMigrations(() => ({ 0: [] })),
    });
    const initialDb = await createSQLiteReactiveDb({ snapshot: new Uint8Array(), logger: () => {} });
    initialDb.db.execute(
      opts.includeTodoTable === false
        ? "CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"
        : "CREATE TABLE _todo (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, tombstone INTEGER NOT NULL DEFAULT 0)",
    );
    const snapshot = initialDb.createSnapshot();
    initialDb.dispose();

    const dbId = `sync-test-${crypto.randomUUID()}`;
    const channels = createBroadcastChannels(dbId);
    let storageGeneration = opts.stateStorageGeneration;
    const postState = () =>
      channels.responses.postMessage({
        notificationType: "state-changed",
        state: { remoteState: "online", deSynced: false, schemaVersionMismatched: false },
        storageGeneration,
      });
    const respond = (requestId: string, data: WorkerResponseMessage["data"]) =>
      channels.responses.postMessage({ type: "response", requestId, data });
    channels.requests.onmessage = async ({ data: request }) => {
      switch (request.method) {
        case "postState":
          postState();
          respond(request.requestId, undefined);
          break;
        case "getSnapshot":
          await opts.beforeSnapshot?.(dbId);
          respond(request.requestId, {
            file: snapshot,
            syncId: 0,
            schemaVersion: 0,
            storageGeneration: opts.snapshotStorageGeneration,
          });
          break;
        case "pullEvents":
          respond(request.requestId, { events: [], hasMore: false, nextSyncId: 0 });
          break;
        default:
          throw new Error(`Unexpected request ${request.method}`);
      }
    };
    const worker = Object.assign(new EventTarget(), {
      onerror: null,
      onmessage: null,
      onmessageerror: null,
      postMessage: vi.fn(postState),
      terminate: vi.fn(),
    }) satisfies Worker;

    let syncedDb: SyncedDb<(typeof schema)["~clientSchema"]>;
    try {
      syncedDb = await createSyncedDb({ dbId, worker, syncDbSchema: schema });
    } catch (error) {
      channels.requests.close();
      channels.responses.close();
      vi.unstubAllGlobals();
      throw error;
    }

    return {
      dbId,
      reload,
      electWorker: (nextStorageGeneration: string) => {
        storageGeneration = nextStorageGeneration;
        postState();
      },
      [Symbol.asyncDispose]: async () => {
        await syncedDb.dispose();
        channels.requests.close();
        channels.responses.close();
        vi.unstubAllGlobals();
      },
    };
  };

  it.runIf(realLocks)("blocks cleanup before reading the snapshot and releases the lock on disposal", async () => {
    await using tab = await setup({
      snapshotStorageGeneration: "gen-1",
      stateStorageGeneration: "gen-1",
      locks: realLocks,
      beforeSnapshot: async (dbId) => {
        expect(await runWithNoActiveReplicas({ dbId, run: () => {} })).toBe(false);
      },
    });

    expect(await runWithNoActiveReplicas({ dbId: tab.dbId, run: () => {} })).toBe(false);
    await tab[Symbol.asyncDispose]();
    expect(await runWithNoActiveReplicas({ dbId: tab.dbId, run: () => {} })).toBe(true);
    const { held } = await navigator.locks.query();
    expect(held?.some((lock) => lock.name === `sync-db-client-lock-${tab.dbId}`)).toBe(false);
  });

  it.runIf(realLocks)("releases the replica lock when memory schema setup fails", async () => {
    let dbId = "";
    await expect(
      setup({
        snapshotStorageGeneration: "gen-1",
        stateStorageGeneration: "gen-1",
        locks: realLocks,
        includeTodoTable: false,
        beforeSnapshot: async (id) => {
          dbId = id;
          expect(await runWithNoActiveReplicas({ dbId, run: () => {} })).toBe(false);
        },
      }),
    ).rejects.toThrow("Table _todo not found");

    expect(await runWithNoActiveReplicas({ dbId, run: () => {} })).toBe(true);
    const { held } = await navigator.locks.query();
    expect(held?.some((lock) => lock.name === `sync-db-client-lock-${dbId}`)).toBe(false);
  });

  it("reloads when a newly elected worker reports a replaced database", async () => {
    await using tab = await setup({ snapshotStorageGeneration: "gen-1", stateStorageGeneration: "gen-1" });

    tab.electWorker("gen-2");
    tab.electWorker("gen-2");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tab.reload).toHaveBeenCalledOnce();
  });

  it("does not reload when a newly elected worker keeps the same database", async () => {
    await using tab = await setup({ snapshotStorageGeneration: "gen-1", stateStorageGeneration: "gen-1" });

    tab.electWorker("gen-1");
    tab.electWorker("gen-1");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(tab.reload).not.toHaveBeenCalled();
  });

  it("reloads when the database was replaced while the tab was loading its snapshot", async () => {
    await using tab = await setup({ snapshotStorageGeneration: "gen-1", stateStorageGeneration: "gen-2" });

    expect(tab.reload).toHaveBeenCalledOnce();
  });
});
