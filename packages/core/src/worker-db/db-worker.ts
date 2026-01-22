import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import type { Logger } from "../logger";
import { createMigrator, type SyncDbMigrator } from "../migrations/migrator";
import { applyWorkerDbSchema, type WorkerDbSchema } from "../migrations/system-schema";
import { createSQLiteCrdtApplyFunction } from "../sqlite-crdt/apply-crdt-event";
import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import {
  type CrdtStorage,
  createCrdtStorage,
  type EventUpdate,
  type GetEventsOptions,
} from "../sqlite-crdt/crdt-storage";
import { createCrdtSyncProducer } from "../sqlite-crdt/crdt-sync-producer";
import { type CreateRemoteSourceFactory, createCrdtSyncRemoteSource } from "../sqlite-crdt/crdt-sync-remote-source";
import type { PersistedCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import { applyKyselyEventsBatchFilters } from "../sqlite-crdt/events-batch-filters";
import { createStoredValue } from "../sqlite-crdt/stored-value";
import { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createSQLiteKvStore, type KvStore } from "../sqlite-kv-store";
import { createDeferredPromise } from "../utils";
import {
  createBroadcastChannels,
  isWorkerInitMessage,
  isWorkerRequestMessage,
  syncDbWorkerLockName,
  type WorkerConfig,
  type WorkerResponseMessage,
  type WorkerRpc,
} from "./worker-common";

const defaultLogger: Logger = (type, message, level = "info") => {
  const logMessage = `[${type}] ${message}`;
  switch (level) {
    case "info":
      console.log(logMessage);
      break;
    case "warning":
      console.warn(logMessage);
      break;
    case "error":
      console.error(logMessage);
      break;
    case "trace":
      console.trace(logMessage);
      break;
  }
};

async function createDbWorker(config: WorkerConfig, opts: WorkerOptions) {
  const broadcastChannels = createBroadcastChannels(config.dbId);
  const logger = opts.logger ?? defaultLogger;

  const sqlite3 = await sqlite3InitModule();

  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: config.dbId,
    directory: `.${config.dbId}`,
    clearOnInit: config.clearOnInit,
    initialCapacity: 8,
  });

  const db = new SQLiteDbWrapper<WorkerDbSchema>({
    db: new pool.OpfsSAHPoolDb(`/${config.dbId}-main.db`),
    logger: logger,
    loggerPrefix: "worker",
    sqlite3,
  });

  db.execute("PRAGMA locking_mode=exclusive", { loggerLevel: "system" });
  db.execute("PRAGMA journal_mode=WAL", { loggerLevel: "system" });
  db.execute("PRAGMA synchronous=NORMAL", { loggerLevel: "system" });

  db.execute(`ATTACH DATABASE '/${config.dbId}-worker.db' as worker`, { loggerLevel: "system" });
  db.execute("PRAGMA worker.locking_mode=exclusive", { loggerLevel: "system" });
  db.execute("PRAGMA worker.journal_mode=WAL", { loggerLevel: "system" });
  db.execute("PRAGMA worker.synchronous=NORMAL", { loggerLevel: "system" });

  applyWorkerDbSchema(db);

  const kvStore = createSQLiteKvStore({
    db,
    metaTableName: "worker.kv",
  });

  const migrator = createMigrator({
    migrations: opts.syncDbSchema.migrations,
    schemaVersion: kvStore.createNumberStoredValue("schema-version", -1),
  });
  migrator.migrateDbToLatest({
    startTransaction: (callback) => {
      db.executeTransaction((tx) => callback({ execute: (sql, parameters) => tx.execute({ sql, parameters }) }));
    },
  });
  db.invalidateDbSchema();

  const localSyncId = createStoredValue({
    initialValue: getLatestSyncId(db),
  });

  const crdtStorage = createCrdtStorage({
    syncId: localSyncId,
    migrator,
    hlc: {
      getNextHLC() {
        throw new Error("Worker DB should not call getNextHLC");
      },
      mergeHLC() {
        return;
      },
    },
    transaction: (callback) => db.executeTransaction(callback),
    handleCrdtEventApply: createSQLiteCrdtApplyFunction({
      db,
      updateLogTableName: "crdt_update_log",
    }),
    persistEvent: (event) => persistEvent(db, event),
    getEventsBatch: (opts) => getEventsBatch(db, opts),
    updateEvent: (syncId, update) => updateEvent(db, syncId, update),
  });

  createCrdtSyncProducer({
    bufferSize: 500,
    storage: crdtStorage,
    broadcastEvents: (chunk) => {
      broadcastChannels.responses.postMessage({
        notificationType: "new-event-chunk-applied",
        newSyncId: chunk.newSyncId,
      });
    },
  });

  const postState = () => {
    broadcastChannels.responses.postMessage({
      notificationType: "state-changed",
      state: {
        remoteState: remoteSource.getState(),
      },
    });
  };

  const remoteSource = createRemoteSource({
    kvStore,
    crdtStorage,
    migrator,
    clientId: config.clientId,
    remoteFactory: opts.createRemoteSource,
  });
  remoteSource.goOnline();

  remoteSource.addEventListener("state-changed", () => {
    postState();
  });

  const rpcTarget: WorkerRpc = {
    execute: (query) => db.execute(query),
    getSnapshot: () => {
      db.execute("PRAGMA journal_mode=off", { loggerLevel: "system" });
      const file = db.createSnapshot();
      db.execute("PRAGMA journal_mode=WAL", { loggerLevel: "system" });
      return {
        file,
        syncId: localSyncId.current,
        schemaVersion: migrator.currentSchemaVersion,
      };
    },
    postState,
    pushTabEvents: (request) => {
      crdtStorage.enqueueLocalEvents(request.events);
      return {
        ok: true,
      };
    },
    pullEvents: (request) => {
      return crdtStorage.getEventsBatch({
        afterSyncId: request.afterSyncId,
        status: "applied",
        excludeOrigin: request.excludeNodeId,
        limit: 100,
      });
    },
    goOnline: () => remoteSource.goOnline(),
    goOffline: () => remoteSource.goOffline("DISCONNECTED"),
  };

  broadcastChannels.requests.onmessage = (event) => {
    const message = event.data;

    if (!isWorkerRequestMessage(message)) {
      return;
    }

    const method = rpcTarget[message.method] as () => ReturnType<WorkerRpc[keyof WorkerRpc]>;
    const data = method.apply(null, message.args as []);

    if (data instanceof Promise) {
      data.then((result) => {
        const response: WorkerResponseMessage = {
          type: "response",
          requestId: message.requestId,
          data: result,
        };
        broadcastChannels.responses.postMessage(response);
      });
    } else {
      const response: WorkerResponseMessage = {
        type: "response",
        requestId: message.requestId,
        data,
      };
      broadcastChannels.responses.postMessage(response);
    }
  };

  rpcTarget.postState();
}

type InitRemoteOptions = {
  kvStore: KvStore;
  clientId: string;
  crdtStorage: CrdtStorage;
  migrator: SyncDbMigrator;
  remoteFactory?: CreateRemoteSourceFactory;
};

function createRemoteSource({ kvStore, clientId, crdtStorage, migrator, remoteFactory }: InitRemoteOptions) {
  return createCrdtSyncRemoteSource({
    bufferSize: 50,
    pullSyncId: kvStore.createNumberStoredValue("pull-sync-id", -1),
    pushSyncId: kvStore.createNumberStoredValue("push-sync-id", -1),
    nodeId: clientId,
    storage: crdtStorage,
    migrator,
    remoteFactory,
  });
}

export async function getWorkerConfig<Props = never>(): Promise<WorkerConfig<Props>> {
  let configSet = false;
  const responsePromise = createDeferredPromise<WorkerConfig>();

  self.onmessage = (event: MessageEvent<unknown>) => {
    if (configSet) {
      console.error("Worker config already set");
      return;
    }

    const message = event.data;
    if (!isWorkerInitMessage(message)) {
      return;
    }

    responsePromise.resolve(message.config);
    configSet = true;
  };

  return responsePromise.promise;
}

type WorkerOptions = {
  syncDbSchema: SyncDbSchema;
  logger?: Logger;
  createRemoteSource?: CreateRemoteSourceFactory;
  workerConfig?: WorkerConfig;
};

export async function startDbWorker(opts: WorkerOptions) {
  const config = opts.workerConfig ?? (await getWorkerConfig());

  await navigator.locks.request(`${syncDbWorkerLockName}-${config.dbId}`, { mode: "exclusive" }, async (lock) => {
    if (!lock) {
      return;
    }

    await createDbWorker(config, opts);

    await new Promise<void>(() => {});
  });

  console.error("Failed to acquire lock");
}

function getLatestSyncId(db: SQLiteDbWrapper<WorkerDbSchema>) {
  const result = db.executePrepared(
    "get-latest-sync-id",
    {},
    (db) => db.selectFrom("worker.crdt_events").select((eb) => eb.fn.max("sync_id").as("sync_id")),
    { loggerLevel: "system" },
  );
  return result[0]?.sync_id ?? 0;
}

function persistEvent(db: SQLiteDbWrapper<WorkerDbSchema>, event: PersistedCrdtEvent) {
  db.executePrepared(
    "persist-crdt-event",
    event,
    (db, params) =>
      db.insertInto("worker.crdt_events").values({
        type: params("type"),
        dataset: params("dataset"),
        item_id: params("item_id"),
        payload: params("payload"),
        schema_version: params("schema_version"),
        sync_id: params("sync_id"),
        status: params("status"),
        timestamp: params("timestamp"),
        origin: params("origin"),
      }),
    { loggerLevel: "system" },
  );
}

function getEventsBatch(db: SQLiteDbWrapper<WorkerDbSchema>, opts: GetEventsOptions) {
  return db.executeKysely(
    (db) => applyKyselyEventsBatchFilters(db.selectFrom("worker.crdt_events").selectAll(), opts),
    { loggerLevel: "system" },
  ).rows;
}

function updateEvent(db: SQLiteDbWrapper<WorkerDbSchema>, syncId: number, update: EventUpdate) {
  db.executePrepared(
    "update-crdt-event",
    { syncId, ...update },
    (db, params) =>
      db
        .updateTable("worker.crdt_events")
        .set({
          status: params("status"),
          schema_version: params("schema_version"),
          type: params("type"),
          dataset: params("dataset"),
          item_id: params("item_id"),
          payload: params("payload"),
        })
        .where("sync_id", "=", params("syncId")),
    { loggerLevel: "system" },
  );
}
