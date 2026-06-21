import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { createImportData } from "../export-import";
import { xxhash } from "../hash";
import { HLCCounter } from "../hlc";
import type { Logger } from "../logger";
import { createMigrator, type SyncDbMigrator } from "../migrations/migrator";
import { applyWorkerDbSchema, type WorkerDbSchema, workerDbConfig } from "../migrations/system-schema";
import { formatSchemaVerificationIssues, verifySyncSchema } from "../schema/verify-sync-schema";
import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import { type CrdtStorage, createCrdtStorage } from "../sqlite-crdt/crdt-storage";
import { createCrdtSyncProducer } from "../sqlite-crdt/crdt-sync-producer";
import { type CreateRemoteSourceFactory, createCrdtSyncRemoteSource } from "../sqlite-crdt/crdt-sync-remote-source";
import type { CrdtEventStatus } from "../sqlite-crdt/crdt-table-schema";
import { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import type { KvStore } from "../sqlite-kv-store";
import { createDeferredPromise } from "../utils";
import { runWorkerEventLogGc } from "./event-log-gc";
import { createIdbResetStore, createReloadRequestHandler, createResetStateStore, type ResetStore } from "./reset-state";
import { createStorageVersionStore } from "./storage-version";
import {
  createBroadcastChannels,
  isWorkerInitMessage,
  isWorkerRequestMessage,
  syncDbClientLockName,
  syncDbWorkerLockName,
  type WorkerConfig,
  type WorkerErrorResponseMessage,
  type WorkerNotificationMessage,
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

  if (opts.verifySchema) {
    const issues = await verifySyncSchema(opts.syncDbSchema);
    if (issues.length > 0) {
      throw new Error(formatSchemaVerificationIssues(issues));
    }
    logger("worker", "Schema verification passed: migrations match the declared schema", "info");
  }

  const [sqlite3] = await Promise.all([sqlite3InitModule(), xxhash.ensureLoaded()]);

  const resetStore = opts.resetStore ?? createIdbResetStore();
  const resetState = createResetStateStore({
    store: resetStore,
    dbId: config.dbId,
  });
  const storageVersion = createStorageVersionStore({
    store: resetStore,
    dbId: config.dbId,
    appStorageVersion: opts.storageVersion,
  });
  const [pendingReset, isVersionMismatch] = await Promise.all([
    resetState.resolvePendingReset(),
    storageVersion.isVersionMismatch(),
  ]);

  if (isVersionMismatch) {
    logger("worker", `Storage version mismatch — resetting local DB to ${storageVersion.currentVersion}`, "warning");
  }

  const pool = await sqlite3.installOpfsSAHPoolVfs({
    name: config.dbId,
    directory: `.${config.dbId}`,
    clearOnInit: !!pendingReset || isVersionMismatch,
    initialCapacity: 8,
  });

  const db = new SQLiteDbWrapper<WorkerDbSchema>({
    db: () => new pool.OpfsSAHPoolDb(`/${config.dbId}-main.db`),
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

  const { kvStore } = applyWorkerDbSchema(db);

  const migrator = createMigrator({
    migrations: opts.syncDbSchema.migrations,
    schemaVersion: kvStore.createNumberStoredValue("schema-version", -1),
    updateLogTableName: workerDbConfig.updateLogTable.fullIdentifier,
  });
  migrator.migrateDbToLatest({
    startTransaction: (callback) => {
      db.executeTransaction((tx) =>
        callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
      );
    },
  });
  db.invalidateDbSchema();

  const pullSyncId = kvStore.createNumberStoredValue("pull-sync-id", -1);
  const pushSyncId = kvStore.createNumberStoredValue("push-sync-id", -1);
  const eventHlcAccumulator = kvStore.createStringStoredValue("crdt.consistency.event_hlc_sum.v2", "");

  // Record the applied reset epoch / storage version only after the wiped DB
  // initialized successfully, so a failed init can be retried by a later
  // elected worker, while a later election does not wipe again.
  if (pendingReset) {
    await resetState.markResetApplied(pendingReset.epoch);
  }
  if (isVersionMismatch) {
    await storageVersion.markCurrentVersionApplied();
  }

  if (opts.eventLogGc === true) {
    runWorkerEventLogGc({
      db,
      dbConfig: workerDbConfig,
      pushSyncId,
      eventHlcAccumulator,
      logger,
    });
  }

  const crdtStorage = createCrdtStorage({
    nodeId: config.clientId,
    initialLocalSyncId: getMaxSyncId(db, "none"),
    migrator,
    hlc: new HLCCounter(config.clientId, () => Date.now()),
    db,
    dbConfig: workerDbConfig,
    eventHlcAccumulator,
    schema: opts.syncDbSchema,
  });

  createCrdtSyncProducer({
    storage: crdtStorage,
    broadcastEvents: (chunk) => {
      broadcastChannels.responses.postMessage({
        notificationType: "new-event-chunk-applied",
        newSyncId: chunk.newSyncId,
        eventHlcSum: chunk.eventHlcSum,
      });
    },
  });

  const remoteSource = createRemoteSource({
    crdtStorage,
    migrator,
    clientId: config.clientId,
    pullSyncId,
    pushSyncId,
    remoteFactory: opts.createRemoteSource,
  });
  remoteSource.goOnline();

  const broadcastNotification = (notification: WorkerNotificationMessage) => {
    broadcastChannels.responses.postMessage(notification);
  };

  const postState = () => {
    broadcastNotification({
      notificationType: "state-changed",
      state: remoteSource.getState(),
    });
  };
  const stateChangedSubscription = remoteSource.addEventListener("state-changed", () => {
    postState();
  });
  const deSyncDetectedSubscription = remoteSource.addEventListener("de-sync-detected", (event) => {
    broadcastNotification({
      notificationType: "de-sync-detected",
      reason: event.payload.reason,
    });
  });
  const remoteSchemaVersionMismatchSubscription = remoteSource.addEventListener(
    "remote-schema-version-mismatch",
    (event) => {
      broadcastNotification({
        notificationType: "remote-schema-version-mismatch",
        remoteSchemaVersion: event.payload.remoteSchemaVersion,
        localSchemaVersion: event.payload.localSchemaVersion,
      });
    },
  );

  const rpcTarget: WorkerRpc = {
    execute: (query) => db.execute(query),
    getSnapshot: () => {
      const appliedSyncId = getMaxSyncId(db, "pending");
      db.execute("PRAGMA journal_mode=off", { loggerLevel: "system" });
      const file = db.createSnapshot();
      db.execute("PRAGMA journal_mode=WAL", { loggerLevel: "system" });
      return {
        file,
        syncId: appliedSyncId,
        schemaVersion: migrator.currentSchemaVersion,
      };
    },
    importData: createImportData({
      schemaVersion: migrator.currentSchemaVersion,
      applyEvents: async (events) => {
        crdtStorage.applyOwnEvents(events);
        await crdtStorage.internal.processEnqueuedEvents();
      },
    }),
    postState,
    pushTabEvents: (request) => {
      const { beforeSyncId, afterSyncId } = crdtStorage.enqueueLocalEvents(request.events, request.nodeId);
      return {
        ok: true,
        beforeSyncId,
        afterSyncId,
      };
    },
    pullEvents: (request) => {
      return crdtStorage.getEventsBatch({
        afterSyncId: request.afterSyncId,
        status: "applied",
        excludeNodeId: request.excludeNodeId ?? "",
        limit: 100,
      });
    },
    goOnline: () => remoteSource.goOnline(),
    goOffline: () => remoteSource.goOffline("DISCONNECTED"),
    requestReload: createReloadRequestHandler({
      resetState,
      broadcast: broadcastNotification,
    }),
  };

  broadcastChannels.requests.onmessage = (event) => {
    const message = event.data;

    if (!isWorkerRequestMessage(message)) {
      return;
    }

    const sendError = (error: unknown) => {
      const response: WorkerErrorResponseMessage = {
        type: "error-response",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : String(error),
      };
      broadcastChannels.responses.postMessage(response);
    };

    try {
      const method = rpcTarget[message.method] as () => ReturnType<WorkerRpc[keyof WorkerRpc]>;
      const data = method.apply(null, message.args as []);

      if (data instanceof Promise) {
        data
          .then((result) => {
            const response: WorkerResponseMessage = {
              type: "response",
              requestId: message.requestId,
              data: result,
            };
            broadcastChannels.responses.postMessage(response);
          })
          .catch(sendError);
      } else {
        const response: WorkerResponseMessage = {
          type: "response",
          requestId: message.requestId,
          data,
        };
        broadcastChannels.responses.postMessage(response);
      }
    } catch (error) {
      sendError(error);
    }
  };

  rpcTarget.postState();

  return async () => {
    stateChangedSubscription.unsubscribe();
    deSyncDetectedSubscription.unsubscribe();
    remoteSchemaVersionMismatchSubscription.unsubscribe();
    await remoteSource.dispose();
    broadcastChannels.requests.close();
    broadcastChannels.responses.close();
    db.close();
  };
}

type InitRemoteOptions = {
  clientId: string;
  crdtStorage: CrdtStorage;
  migrator: SyncDbMigrator;
  pullSyncId: ReturnType<KvStore["createNumberStoredValue"]>;
  pushSyncId: ReturnType<KvStore["createNumberStoredValue"]>;
  remoteFactory?: CreateRemoteSourceFactory;
};

function createRemoteSource({
  clientId,
  crdtStorage,
  migrator,
  pullSyncId,
  pushSyncId,
  remoteFactory,
}: InitRemoteOptions) {
  return createCrdtSyncRemoteSource({
    bufferSize: 50,
    pullSyncId,
    pushSyncId,
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
  /** Durable storage for reset state. Defaults to an IndexedDB-backed store. */
  resetStore?: ResetStore;
  /**
   * App-provided storage version, combined with the library's internal storage
   * version. Bump it when deploying a code change that old persisted local DBs
   * cannot survive — on mismatch the elected worker wipes the local DB on startup.
   */
  storageVersion?: string;
  /**
   * Dev-time drift check: replays the full migration history on a throwaway
   * in-memory database and verifies the result matches the schema declared with
   * `defineSyncSchema`. On mismatch the worker throws and refuses to start.
   * Enable in development only, e.g. `verifySchema: import.meta.env.DEV`.
   */
  verifySchema?: boolean;
  /**
   * Runs local worker event-log garbage collection on startup. Disabled by default;
   * set `eventLogGc: true` to enable. GC keeps the latest event rows and never removes
   * pending events or local rows that have not been pushed to the remote.
   */
  eventLogGc?: boolean;
};

export async function startDbWorker(opts: WorkerOptions) {
  const config = opts.workerConfig ?? (await getWorkerConfig());

  await navigator.locks.request(`${syncDbWorkerLockName}-${config.dbId}`, { mode: "exclusive" }, async (lock) => {
    if (!lock) {
      return;
    }

    const cleanup = await createDbWorker(config, opts);

    const clientLockName = `${syncDbClientLockName}-${config.dbId}`;
    await new Promise<void>((resolve) => {
      const interval = setInterval(async () => {
        const { held } = await navigator.locks.query();
        const hasClients = held?.some((l) => l.name === clientLockName && l.mode === "shared");
        if (!hasClients) {
          clearInterval(interval);
          resolve();
        }
      }, 5_000);
    });

    await cleanup();
  });

  self.close();
}

function getMaxSyncId(db: SQLiteDbWrapper<WorkerDbSchema>, excludingStatus: "none" | "pending") {
  const [result] = db.executePrepared(
    "get-max-sync-id",
    { excludingStatus: excludingStatus as CrdtEventStatus },
    (db, params) =>
      db
        .selectFrom("worker.crdt_events")
        .where("status", "!=", params("excludingStatus"))
        .select((eb) => eb.fn.max("sync_id").as("sync_id")),
    { loggerLevel: "system" },
  );

  return result?.sync_id ?? 0;
}
