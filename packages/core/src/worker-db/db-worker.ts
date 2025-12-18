import sqlite3InitModule, { type SAHPoolUtil } from "@sqlite.org/sqlite-wasm";
import type { Kysely, Migration } from "kysely";
import type { Logger } from "../logger";
import { createSyncDbMigrator } from "../migrations/migrator";
import { applyWorkerDbSchema, type WorkerDbSchema } from "../migrations/system-schema";
import { applyCrdtEventMutations } from "../sqlite-crdt/apply-crdt-event";
import { createCrdtStorage, type GetEventsBatch, type GetEventsOptions } from "../sqlite-crdt/crdt-storage";
import { createCrdtSyncProducer } from "../sqlite-crdt/crdt-sync-producer";
import {
  type CrdtSyncRemoteSource,
  createCrdtSyncRemoteSource,
  type EventsPullRequest,
  type EventsPushRequest,
  type EventsPushResponse,
} from "../sqlite-crdt/crdt-sync-remote-source";
import type { CrdtEventStatus, PersistedCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import { applyKyselyEventsBatchFilters } from "../sqlite-crdt/events-batch-filters";
import { createSyncIdCounter } from "../sqlite-crdt/sync-id-counter";
import { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createSQLiteKysely } from "../sqlite-kysely";
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
  const broadcastChannels = createBroadcastChannels();
  const logger = opts.logger ?? defaultLogger;

  const sqlite3 = await sqlite3InitModule();

  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: "sync-db-storage",
    clearOnInit: opts.clearOnInit,
  });

  await normalizePoolCapacity(pool);

  const db = new SQLiteDbWrapper<WorkerDbSchema>({
    db: new pool.OpfsSAHPoolDb(config.dbPath),
    logger: logger,
    loggerPrefix: "worker",
    sqlite3,
  });

  db.execute("PRAGMA locking_mode=exclusive");
  db.execute("PRAGMA journal_mode=WAL");
  db.execute(`ATTACH DATABASE '${config.dbPath}-worker' as worker`);
  applyWorkerDbSchema(db);
  const kysely = createSQLiteKysely<WorkerDbSchema>(db);
  const migrator = createSyncDbMigrator({
    db: kysely as Kysely<unknown>,
    migrations: opts.migrations,
  });
  await migrator.migrateToLatest();
  db.invalidateDbSchema();

  const localSyncId = createSyncIdCounter({
    initialSyncId: getLatestSyncId(db),
  });

  const crdtStorage = createCrdtStorage({
    syncId: localSyncId,
    applyCrdtEventMutations: (event) =>
      applyCrdtEventMutations({
        db,
        event,
        updateLogTableName: "crdt_update_log",
      }),
    persistEvents: (events) => persistEvents(db, events),
    getEventsBatch: (opts) => getEventsBatch(db, opts),
    updateEventStatus: (syncId, status) => updateEventStatus(db, syncId, status),
  });

  createCrdtSyncProducer({
    bufferSize: 100,
    storage: crdtStorage,
    broadcastEvents: (chunk) => {
      broadcastChannels.responses.postMessage({
        notificationType: "new-event-chunk-applied",
        newSyncId: chunk.newSyncId,
      });
    },
  });

  if (opts.createRemoteSource) {
    let crdtSyncRemoteSource: CrdtSyncRemoteSource | null = null;
    const remoteSource = opts.createRemoteSource?.({
      onEventsAvailable: () => {
        crdtSyncRemoteSource?.pullEvents();
      },
    });

    const storedRemoteSyncId = Number.parseInt(getMetaValue(db, "pull-sync-id"), 10);
    const pullIdCounter = createSyncIdCounter({
      initialSyncId: Number.isNaN(storedRemoteSyncId) ? -1 : storedRemoteSyncId,
      saveToStorage: (syncId) => setMetaValue(db, "pull-sync-id", syncId.toString()),
    });

    const storedPushSyncId = Number.parseInt(getMetaValue(db, "push-sync-id"), 10);
    const pushIdCounter = createSyncIdCounter({
      initialSyncId: Number.isNaN(storedPushSyncId) ? -1 : storedPushSyncId,
      saveToStorage: (syncId) => setMetaValue(db, "push-sync-id", syncId.toString()),
    });
    crdtSyncRemoteSource = createCrdtSyncRemoteSource({
      bufferSize: 50,
      pullSyncId: pullIdCounter,
      pushSyncId: pushIdCounter,
      nodeId: config.clientId,
      storage: crdtStorage,
      pullEvents: remoteSource.pullEvents,
      pushEvents: remoteSource.pushEvents,
    });
    await crdtSyncRemoteSource.pullEvents({ includeSelf: true });
  }

  const rpcTarget: WorkerRpc = {
    execute: (query) => db.execute(query),
    getSnapshot: () => {
      db.execute("PRAGMA journal_mode=off");
      const file = db.createSnapshot();
      db.execute("PRAGMA journal_mode=WAL");
      return {
        file,
        syncId: localSyncId.current,
      };
    },
    postInitReady: () => {
      broadcastChannels.responses.postMessage({
        type: "init-ready",
      });
    },
    pushTabEvents: (request) => {
      crdtStorage.enqueueEvents(
        request.events.map((event) => ({
          ...event,
          origin: request.nodeId,
        })),
      );
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
  };

  broadcastChannels.requests.onmessage = (event) => {
    const message = event.data;

    if (!isWorkerRequestMessage(message)) {
      return;
    }

    const method = rpcTarget[message.method] as () => ReturnType<WorkerRpc[keyof WorkerRpc]>;
    const data = method.apply(null, message.args as []);
    const response: WorkerResponseMessage = {
      type: "response",
      requestId: message.requestId,
      data,
    };
    broadcastChannels.responses.postMessage(response);
  };

  rpcTarget.postInitReady();
}

async function getConfig(): Promise<WorkerConfig> {
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

async function normalizePoolCapacity(pool: SAHPoolUtil) {
  const capacity = pool.getCapacity();
  const fileCount = pool.getFileCount();
  const capacityDiff = capacity - fileCount;

  if (capacityDiff < 6) {
    await pool.addCapacity(6 - capacityDiff);
  } else {
    await pool.reduceCapacity(capacityDiff - 6);
  }
}

type WorkerOptions = {
  migrations: Record<number, Migration>;
  logger?: Logger;
  createRemoteSource?: CreateRemoteSourceFactory;
  clearOnInit?: boolean;
};

type CreateRemoteSourceFactory = (opts: { onEventsAvailable: (newSyncId: number) => void }) => {
  pullEvents: (request: EventsPullRequest) => Promise<GetEventsBatch>;
  pushEvents: (request: EventsPushRequest) => Promise<EventsPushResponse>;
};

export async function startDbWorker(opts: WorkerOptions) {
  const config = await getConfig();

  await navigator.locks.request(syncDbWorkerLockName, { mode: "exclusive" }, async (lock) => {
    if (!lock) {
      return;
    }

    await createDbWorker(config, opts);

    await new Promise<void>(() => {});
  });

  console.error("Failed to acquire lock");
}

function getLatestSyncId(db: SQLiteDbWrapper<WorkerDbSchema>) {
  const result = db.executePrepared("get-latest-sync-id", {}, (db) =>
    db.selectFrom("worker.crdt_events").select((eb) => eb.fn.max("sync_id").as("sync_id")),
  );
  return result[0]?.sync_id ?? 0;
}

function persistEvents(db: SQLiteDbWrapper<WorkerDbSchema>, events: PersistedCrdtEvent[]) {
  db.executeTransaction((db) => {
    const chunkSize = 100;
    for (let i = 0; i < events.length; i += chunkSize) {
      const chunk = events.slice(i, i + chunkSize);
      db.executeKysely((db) => db.insertInto("worker.crdt_events").values(chunk));
    }
  });
}

function getEventsBatch(db: SQLiteDbWrapper<WorkerDbSchema>, opts: GetEventsOptions) {
  return db.executeKysely((db) => applyKyselyEventsBatchFilters(db.selectFrom("worker.crdt_events").selectAll(), opts))
    .rows;
}

function updateEventStatus(db: SQLiteDbWrapper<WorkerDbSchema>, syncId: number, status: CrdtEventStatus) {
  db.executePrepared("update-crdt-event-status", { syncId, status }, (db, params) =>
    db
      .updateTable("worker.crdt_events")
      .set({ status: params("status") })
      .where("sync_id", "=", params("syncId")),
  );
}

function getMetaValue(db: SQLiteDbWrapper<WorkerDbSchema>, key: string) {
  const [result] = db.executePrepared("get-meta-value", { key }, (db, params) =>
    db.selectFrom("worker.meta").where("key", "=", params("key")).select("value"),
  );
  return result?.value ?? null;
}

function setMetaValue(db: SQLiteDbWrapper<WorkerDbSchema>, key: string, value: string) {
  db.executePrepared("set-meta-value", { key, value }, (db, params) =>
    db
      .insertInto("worker.meta")
      .values({ key: params("key"), value: params("value") })
      .onConflict((oc) => oc.doUpdateSet({ value: params("value") })),
  );
}
