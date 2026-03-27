import { validateDbId } from "./db-id";
import { getOrCreateSQLiteSyncDevtoolsRegistry } from "./devtools-registry";
import { HLCCounter } from "./hlc";
import { type Logger, startPerformanceLogger } from "./logger";
import { createMemoryDb } from "./memory-db/memory-db";
import { createSQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
import type { SyncDbMigrator } from "./migrations/migrator";
import type { SyncDbSchema } from "./sqlite-crdt/crdt-schema";
import { createCrdtSyncRemoteSource } from "./sqlite-crdt/crdt-sync-remote-source";
import { createStoredValue } from "./sqlite-crdt/stored-value";
import { createDeferredPromise, generateId, type TypedEvent } from "./utils";
import { createWorkerDbClient } from "./worker-db/db-worker-client";
import {
  createBroadcastChannels,
  syncDbClientLockName,
  type WorkerNotificationMessage,
} from "./worker-db/worker-common";

type SyncedDbOptions<Database, Props = undefined> = {
  dbId: string;
  clearOnInit?: boolean;
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

const devtoolsClearKey = (dbId: string) => `__sqlite_sync_devtools_clear_${dbId}`;

function readDevtoolsClearFlag(clearKey: string): boolean {
  try {
    return globalThis.localStorage?.getItem(clearKey) === "1";
  } catch {
    return false;
  }
}

function consumeDevtoolsClearFlag(clearKey: string): void {
  try {
    globalThis.localStorage?.removeItem(clearKey);
  } catch {
    // Ignore environments where storage is unavailable or blocked.
  }
}

export async function createSyncedDb<Database, Props = undefined>(options: SyncedDbOptions<Database, Props>) {
  validateDbId(options.dbId);

  const perf = startPerformanceLogger(defaultLogger);

  const instanceId = generateId();
  const tabId = generateId();

  const clearKey = devtoolsClearKey(options.dbId);
  const devtoolsClear = readDevtoolsClearFlag(clearKey);
  if (devtoolsClear) {
    consumeDevtoolsClearFlag(clearKey);
  }

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
      clearOnInit: options.clearOnInit || devtoolsClear,
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
      const onNewEventChunkApplied = (
        event: TypedEvent<Extract<WorkerNotificationMessage, { notificationType: "new-event-chunk-applied" }>>,
      ) => {
        onEventsAvailable(event.payload.newSyncId);
      };
      workerClient.addEventListener("new-event-chunk-applied", onNewEventChunkApplied);

      return {
        pullEvents: (request) => workerClient.pullEvents(request),
        pushEvents: (request) => workerClient.pushTabEvents(request),
        disconnect: () => {
          workerClient.removeEventListener("new-event-chunk-applied", onNewEventChunkApplied);
        },
      };
    },
  });
  tabRemoteSource.goOnline();

  perf.logEnd("createSyncedDb", "initialized", "info");

  let isDisposed = false;
  let unregisterDevtools: (() => void) | undefined;
  const dispose = async () => {
    if (isDisposed) return;
    isDisposed = true;

    unregisterDevtools?.();
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
    },
    state: {
      getState: workerClient.getState.bind(workerClient),
      subscribe: (onChange: () => void) => {
        workerClient.addEventListener("state-changed", onChange);
        return () => {
          workerClient.removeEventListener("state-changed", onChange);
        };
      },
      goOnline: workerClient.goOnline.bind(workerClient),
      goOffline: workerClient.goOffline.bind(workerClient),
    },
    dispose,
    _internal: {
      executeAsync: workerClient.execute.bind(workerClient),
      getMemoryQueryTables: reactiveDb.getTablesUsed.bind(reactiveDb),
      crdtTableNames: options.syncDbSchema.tablesConfig.map((table) => table.crdtTableName),
      crdtTablesConfig: options.syncDbSchema.tablesConfig,
      schemaVersion: workerClientSnapshot.schemaVersion,
      migrationVersions: Object.keys(options.syncDbSchema.migrations)
        .map(Number)
        .sort((a, b) => a - b),
      devtoolsClearKey: clearKey,
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
