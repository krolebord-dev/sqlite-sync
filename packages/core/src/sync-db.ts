import { deserializeHLC, HLCCounter } from "./hlc";
import { type Logger, startPerformanceLogger } from "./logger";
import { createMemoryDb, type MemoryDbCrdtTableConfig } from "./memory-db/memory-db";
import { createSQLiteReactiveDb, type SQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
import type { SyncDbMigrator } from "./migrations/migrator";
import { createCrdtSyncRemoteSource } from "./sqlite-crdt/crdt-sync-remote-source";
import { createStoredValue } from "./sqlite-crdt/stored-value";
import { generateId, type TypedEvent } from "./utils";
import { createWorkerDbClient } from "./worker-db/db-worker-client";
import { createBroadcastChannels, type WorkerNotificationMessage } from "./worker-db/worker-common";

type SyncedDbOptions = {
  dbPath: string;
  clearOnInit?: boolean;
  crdtTables: MemoryDbCrdtTableConfig[];
  worker: Worker;
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

export async function createSyncedDb<Database>(options: SyncedDbOptions) {
  if (!options.dbPath.startsWith("/")) {
    throw new Error("dbPath must be an absolute path");
  }

  const perf = startPerformanceLogger(defaultLogger);

  const tabId = generateId();

  const broadcastChannels = createBroadcastChannels();

  const workerClient = await createWorkerDbClient({
    worker: options.worker,
    config: {
      clientId: generateId(),
      dbPath: options.dbPath,
      clearOnInit: options.clearOnInit,
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
  };
  const { crdtStorage } = await createMemoryDb({
    migrator: memoryDbMigrator,
    reactiveDb: reactiveDb,
    hlcCounter,
    tabId,
    crdtTables: options.crdtTables,
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

  crdtStorage.addEventListener("event-applied", (event) => {
    if (event.payload.origin === "remote") {
      hlcCounter.mergeHLC(deserializeHLC(event.payload.timestamp));
    }
  });

  perf.logEnd("createSyncedDb", "initialized", "info");

  return {
    db: reactiveDb.db,
    reactiveDb: reactiveDb as Omit<SQLiteReactiveDb<Database>, "db">,
    workerDb: workerClient,
  };
}

export type SyncedDb<Database> = Awaited<ReturnType<typeof createSyncedDb<Database>>>;
