import { validateDbId } from "./db-id";
import { getOrCreateSQLiteSyncDevtoolsRegistry } from "./devtools-registry";
import { createExportImport } from "./export-import";
import { HLCCounter } from "./hlc";
import { type Logger, startPerformanceLogger } from "./logger";
import { createMemoryDb } from "./memory-db/memory-db";
import { createSQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
import type { SyncDbMigrator } from "./migrations/migrator";
import type { SyncDbSchema } from "./sqlite-crdt/crdt-schema";
import { createCrdtSyncRemoteSource } from "./sqlite-crdt/crdt-sync-remote-source";
import { createStoredValue } from "./sqlite-crdt/stored-value";
import { createDeferredPromise, generateId } from "./utils";
import { createWorkerDbClient } from "./worker-db/db-worker-client";
import { createBroadcastChannels, syncDbClientLockName } from "./worker-db/worker-common";

type SyncedDbOptions<Database, Props = undefined> = {
  dbId: string;
  worker: Worker;
  workerProps: Props;
  syncDbSchema: SyncDbSchema<Database>;
};

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

export async function createSyncedDb<Database, Props = undefined>(options: SyncedDbOptions<Database, Props>) {
  validateDbId(options.dbId);

  const perf = startPerformanceLogger(defaultLogger);

  const instanceId = generateId();
  const tabId = generateId();

  const broadcastChannels = createBroadcastChannels(options.dbId);

  const clientLockAcquired = createDeferredPromise<void>();
  const clientLockRelease = createDeferredPromise<void>();
  navigator.locks.request(`${syncDbClientLockName}-${options.dbId}`, { mode: "shared" }, () => {
    clientLockAcquired.resolve();
    return clientLockRelease.promise;
  });
  await clientLockAcquired.promise;

  const workerClient = await createWorkerDbClient({
    worker: options.worker,
    config: {
      clientId: generateId(),
      dbId: options.dbId,
      props: options.workerProps as never,
    },
    broadcastChannels,
  });

  const hlcCounter = new HLCCounter(tabId, () => Date.now());

  const workerClientSnapshot = await workerClient.getSnapshot();
  const reactiveDb = await createSQLiteReactiveDb<Database>({
    snapshot: workerClientSnapshot.file,
    logger: defaultLogger,
  });

  const memoryDbMigrator: SyncDbMigrator = {
    currentSchemaVersion: workerClientSnapshot.schemaVersion,
    latestSchemaVersion: workerClientSnapshot.schemaVersion,
    migrateDbToLatest: () => {
      throw new Error("Memory DB migrations are not implemented");
    },
    migrateEvent: (event, targetVersion) => {
      if (event.schema_version === targetVersion) {
        return event;
      }
      throw new Error("Memory DB migrations are not implemented");
    },
    migrateEvents: (events) => events,
  };
  const { crdtStorage } = await createMemoryDb({
    nodeId: tabId,
    migrator: memoryDbMigrator,
    reactiveDb: reactiveDb,
    hlcCounter,
    crdtTables: options.syncDbSchema.tablesConfig,
    syncDbSchema: options.syncDbSchema,
  });

  const pullSyncId = createStoredValue({
    initialValue: workerClientSnapshot.syncId,
  });
  const pushSyncId = createStoredValue({
    initialValue: 0,
  });
  const tabRemoteSource = createCrdtSyncRemoteSource({
    bufferSize: 500,
    pullSyncId,
    pushSyncId,
    storage: crdtStorage,
    nodeId: tabId,
    migrator: memoryDbMigrator,
    remoteFactory: ({ onEventsAvailable }) => {
      const subscription = workerClient.subscribe("new-event-chunk-applied", (event) => {
        onEventsAvailable({ newSyncId: event.payload.newSyncId, remoteEventHlcSum: event.payload.eventHlcSum });
      });

      return {
        pullEvents: (request) => workerClient.pullEvents(request),
        pushEvents: (request) => workerClient.pushTabEvents(request),
        disconnect: () => {
          subscription.unsubscribe();
        },
      };
    },
  });
  tabRemoteSource.goOnline();

  const reloadRequestedSubscription = workerClient.subscribe("reload-requested", () => {
    globalThis.location?.reload();
  });

  perf.logEnd("createSyncedDb", "initialized", "info");

  const { exportData, importData } = createExportImport({
    reactiveDb,
    crdtStorage,
    tablesConfig: options.syncDbSchema.tablesConfig,
    schemaVersion: workerClientSnapshot.schemaVersion,
    importData: (data, opts) => workerClient.importData(data, opts),
  });

  let isDisposed = false;
  let unregisterDevtools: (() => void) | undefined;
  const dispose = async () => {
    if (isDisposed) return;
    isDisposed = true;

    unregisterDevtools?.();
    reloadRequestedSubscription.unsubscribe();
    clientLockRelease.resolve();
    await tabRemoteSource.dispose();
    broadcastChannels.requests.close();
    broadcastChannels.responses.close();
    workerClient.dispose();
    reactiveDb.dispose();
  };

  const syncedDb = {
    db: {
      execute: reactiveDb.db.execute.bind(reactiveDb.db),
      executeKysely: reactiveDb.db.executeKysely.bind(reactiveDb.db),
      executeTransaction: reactiveDb.db.executeTransaction.bind(reactiveDb.db),
      createLiveQuery: reactiveDb.createLiveQuery.bind(reactiveDb),
      getSharedLiveQuery: reactiveDb.getSharedLiveQuery.bind(reactiveDb),
    },
    state: {
      getState: workerClient.getState.bind(workerClient),
      subscribe: (onChange: () => void) => {
        const { unsubscribe } = workerClient.subscribe("state-changed", onChange);
        return unsubscribe;
      },
      goOnline: workerClient.goOnline.bind(workerClient),
      goOffline: workerClient.goOffline.bind(workerClient),
    },
    /**
     * Ask the elected worker to broadcast a page reload to all tabs for this dbId.
     *
     * With `clean: true` the worker durably records a reset request epoch before
     * broadcasting, so the worker elected on the next startup initializes with
     * `clearOnInit: true` and wipes the persisted DB. Destructive — use as a
     * recovery path when the durable worker DB may be de-synced.
     *
     * Pending in-memory tab events are not preserved, and the returned promise
     * may never settle in the caller — the page typically unloads first.
     */
    requestReload: async (options: { clean: boolean }) => {
      await workerClient.requestReload(options);
      // Primary path: this tab receives the worker's "reload-requested" broadcast
      // like every other tab. Fallback in case the broadcast is missed — in the
      // normal case the page is already unloading and this timeout never fires.
      setTimeout(() => globalThis.location?.reload(), 250);
    },
    subscribe: workerClient.subscribe,
    exportData,
    importData,
    dispose,
    _internal: {
      executeAsync: workerClient.execute.bind(workerClient),
      getMemoryQueryTables: reactiveDb.getTablesUsed.bind(reactiveDb),
      getSharedLiveQueriesSnapshot: reactiveDb.getSharedLiveQueriesSnapshot.bind(reactiveDb),
      crdtTableNames: options.syncDbSchema.tablesConfig.map((table) => table.crdtTableName),
      crdtTablesConfig: options.syncDbSchema.tablesConfig,
      schemaVersion: workerClientSnapshot.schemaVersion,
      migrationVersions: Object.keys(options.syncDbSchema.migrations)
        .map(Number)
        .sort((a, b) => a - b),
    },
  };

  unregisterDevtools = getOrCreateSQLiteSyncDevtoolsRegistry().register({
    instanceId,
    dbId: options.dbId,
    createdAt: Date.now(),
    instance: syncedDb,
  });

  return syncedDb;
}

export type SyncedDb<Database> = Awaited<ReturnType<typeof createSyncedDb<Database>>>;
