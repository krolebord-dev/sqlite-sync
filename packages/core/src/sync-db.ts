import { deserializeHLC, HLCCounter } from "./hlc";
import { createMemoryDb, type MemoryDbCrdtTableConfig } from "./memory-db/memory-db";
import { createSQLiteReactiveDb, type SQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
import { createCrdtSyncRemoteSource } from "./sqlite-crdt/crdt-sync-remote-source";
import { createSyncIdCounter } from "./sqlite-crdt/sync-id-counter";
import { generateId, type TypedEvent } from "./utils";
import { createWorkerDbClient } from "./worker-db/db-worker-client";
import { createBroadcastChannels, type WorkerNotificationMessage } from "./worker-db/worker-common";

type SyncedDbOptions = {
  dbPath: string;
  clearOnInit?: boolean;
  crdtTables: MemoryDbCrdtTableConfig[];
  worker: Worker;
};

export async function createSyncedDb<Database>(options: SyncedDbOptions) {
  if (!options.dbPath.startsWith("/")) {
    throw new Error("dbPath must be an absolute path");
  }

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
  });
  const { crdtStorage } = await createMemoryDb({
    reactiveDb: reactiveDb,
    hlcCounter,
    tabId,
    crdtTables: options.crdtTables,
  });

  const pullSyncId = createSyncIdCounter({
    initialSyncId: workerClientSnapshot.syncId,
  });
  const pushSyncId = createSyncIdCounter({
    initialSyncId: 0,
  });
  const tabRemoteSource = createCrdtSyncRemoteSource({
    bufferSize: 100,
    pullSyncId,
    pushSyncId,
    storage: crdtStorage,
    nodeId: tabId,
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

  return {
    db: reactiveDb.db,
    reactiveDb: reactiveDb as Omit<SQLiteReactiveDb<Database>, "db">,
    workerDb: workerClient,
  };
}

export type SyncedDb<Database> = Awaited<ReturnType<typeof createSyncedDb<Database>>>;
