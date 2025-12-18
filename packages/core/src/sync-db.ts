import { deserializeHLC, HLCCounter } from "./hlc";
import { createMemoryDb, type MemoryDbCrdtTableConfig } from "./memory-db/memory-db";
import { createSQLiteReactiveDb, type SQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
import { createCrdtSyncRemoteSource } from "./sqlite-crdt/crdt-sync-remote-source";
import { createSyncIdCounter } from "./sqlite-crdt/sync-id-counter";
import { generateId } from "./utils";
import { createWorkerDbClient, initializeWorkerDb } from "./worker-db/db-worker-client";
import { createBroadcastChannels } from "./worker-db/worker-common";

type SyncedDbOptions = {
  dbPath: string;
  clearOnInit?: boolean;
  // tabId?: string;
  // clientId: string;
  // logger?: Logger;
  crdtTables: MemoryDbCrdtTableConfig[];

  worker: Worker;
};

export async function createSyncedDb<Database>(options: SyncedDbOptions) {
  if (!options.dbPath.startsWith("/")) {
    throw new Error("dbPath must be an absolute path");
  }

  const tabId = generateId();

  const broadcastChannels = createBroadcastChannels();

  await initializeWorkerDb({
    worker: options.worker,
    broadcastChannels,
    config: {
      clientId: generateId(),
      dbPath: options.dbPath,
    },
  });

  const workerClient = createWorkerDbClient({
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
  const remoteSyncSource = createCrdtSyncRemoteSource({
    bufferSize: 100,
    pullSyncId,
    pushSyncId,
    storage: crdtStorage,
    nodeId: tabId,
    pullEvents: (request) => workerClient.pullEvents(request),
    pushEvents: (request) => workerClient.pushTabEvents(request),
  });

  workerClient.addEventListener("new-notification", (event) => {
    const notification = event.payload;
    if (notification.notificationType === "new-event-chunk-applied") {
      remoteSyncSource.pullEvents();
    }
  });

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
