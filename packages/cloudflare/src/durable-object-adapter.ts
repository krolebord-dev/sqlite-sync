import {
  baseSystemMigrations,
  type CrdtEventOrigin,
  type CrdtEventStatus,
  type CrdtEventType,
  type CrdtStorage,
  type CrdtStorageMutator,
  type CrdtUpdateLogItem,
  createCrdtStorage,
  createCrdtStorageMutator,
  createCrdtSyncProducer,
  createStoredValue,
  createSystemDbConfig,
  createTypedEventTarget,
  HLCCounter,
  jsonSafeParse,
  type PersistedCrdtEvent,
  quoteId,
  runSystemMigrations,
  type SyncDbSchema,
  type TypedEventTarget,
  xxhash,
} from "@sqlite-sync/core";
import {
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerZodSchema,
} from "@sqlite-sync/core/server";
import { createCrdtStorageDb, createKyselyExecutor, type KyselyExecutor } from "./kysely-executor";
import { createMigrator } from "./migrator";

const updateLogTableName = "__crdt_update_log";

type AdapterDb = {
  crdtEvents: PersistedCrdtEvent;
  [updateLogTableName]: CrdtUpdateLogItem;
};

export type TypedPersistedCrdtEvent<Schema extends SyncDbSchema> = {
  schema_version: number;
  sync_id: number;
  status: CrdtEventStatus;
  type: CrdtEventType;
  timestamp: string;
  origin: CrdtEventOrigin;
  source_node_id: string;
  dataset: keyof Schema[`~mutationsSchema`];
  item_id: string;
  payload: string;
};

type ServerSyncDbEvents<Schema extends SyncDbSchema> = {
  "event-applied": TypedPersistedCrdtEvent<Schema>;
};

export type ServerSyncDb<Schema extends SyncDbSchema> = Pick<
  KyselyExecutor<Schema[`~serverSchema`]>,
  "execute" | "executeKysely"
> &
  Pick<CrdtStorage, "applyOwnEvents"> &
  CrdtStorageMutator<Schema[`~mutationsSchema`]> &
  Pick<TypedEventTarget<ServerSyncDbEvents<Schema>>, "addEventListener" | "removeEventListener">;

async function createDurableObjectCrdtStorage<Schema extends SyncDbSchema>({
  storage,
  syncDbSchema,
  nodeId,
  crdtEventsTable = "crdt_events",
  batchSize = 50,
  broadcastPayload,
}: {
  storage: DurableObjectStorage;
  syncDbSchema: Schema;
  nodeId: string;
  crdtEventsTable: string;
  batchSize?: number;
  broadcastPayload: (payload: string) => void;
}): Promise<{
  syncDb: ServerSyncDb<Schema>;
  remoteHandler: RemoteHandler;
}> {
  await xxhash.ensureLoaded();

  const dbConfig = createSystemDbConfig({
    eventsTableName: crdtEventsTable,
    updateLogTableName: updateLogTableName,
  });

  const eventTarget = createTypedEventTarget<ServerSyncDbEvents<Schema>>();
  const sqlExecutor = createKyselyExecutor<AdapterDb>(storage);
  const crdtStorageDb = createCrdtStorageDb(sqlExecutor);

  runSystemMigrations({
    migrations: baseSystemMigrations,
    version: createStoredValue<number>({
      initialValue: storage.kv.get("internal-schema-version") ?? -1,
      saveToStorage: (val) => storage.kv.put("internal-schema-version", val),
    }),
    dbConfig,
    execute: (sql) => sqlExecutor.execute({ sql, parameters: [] }),
    transaction: (callback) => sqlExecutor.transaction(callback),
  });

  const migrator = createMigrator(
    storage.kv,
    sqlExecutor,
    syncDbSchema.migrations,
    dbConfig.updateLogTable.fullIdentifier,
  );
  migrator.migrateDbToLatest();
  createReadOnlyCrdtViews(sqlExecutor, syncDbSchema);

  const truncatedNodeId = nodeId.slice(0, 12);
  const hlc = new HLCCounter(truncatedNodeId, () => Date.now());

  const crdtStorage = createCrdtStorage({
    nodeId: truncatedNodeId,
    initialLocalSyncId: getLatestSyncId(sqlExecutor),
    hlc,
    migrator: migrator,
    db: crdtStorageDb,
    dbConfig,
    eventHlcAccumulator: createStoredValue<string>({
      initialValue: storage.kv.get("crdt.consistency.event_hlc_sum.v3") ?? "",
      saveToStorage: (val) => storage.kv.put("crdt.consistency.event_hlc_sum.v3", val),
    }),
    onEventApplied: (event) => {
      queueMicrotask(() => {
        eventTarget.dispatchEvent("event-applied", event as TypedPersistedCrdtEvent<Schema>);
      });
    },
    schema: syncDbSchema,
  });

  const remoteHandler = createDurableObjectRemoteHandler({
    bufferSize: batchSize,
    crdtStorage,
    broadcastPayload,
  });

  const syncDbMutator = createCrdtStorageMutator<Schema[`~mutationsSchema`]>({
    storage: crdtStorage,
  });

  const syncDbExecutor = sqlExecutor as unknown as KyselyExecutor<Schema[`~serverSchema`]>;
  const syncDb: ServerSyncDb<Schema> = {
    ...syncDbExecutor,
    ...syncDbMutator,
    applyOwnEvents: crdtStorage.applyOwnEvents,
    addEventListener: eventTarget.addEventListener,
    removeEventListener: eventTarget.removeEventListener,
  };

  return {
    syncDb,
    remoteHandler,
  };
}

type MessageResult = { success: true; payload: string } | { success: false; error: unknown };
export type RemoteHandler = {
  handleMessage: (message: string) => MessageResult;
};

function createDurableObjectRemoteHandler({
  bufferSize = 50,
  crdtStorage,
  broadcastPayload,
}: {
  bufferSize?: number;
  crdtStorage: CrdtStorage;
  broadcastPayload: (payload: string) => void;
}): RemoteHandler {
  createCrdtSyncProducer({
    storage: crdtStorage,
    broadcastEvents: (chunk) => {
      broadcastPayload(
        JSON.stringify({
          type: "events-applied",
          newSyncId: chunk.newSyncId,
          eventHlcSum: chunk.eventHlcSum,
        }),
      );
    },
  });

  const handleMessage = (message: string): MessageResult => {
    const requestRaw = jsonSafeParse<SyncServerRequest>(message);

    if (!requestRaw.success) {
      return { success: false, error: requestRaw.error };
    }

    const requestResult = syncServerZodSchema.request.safeParse(requestRaw.data);

    if (!requestResult.success) {
      console.log("Invalid request", requestResult.error);
      return { success: false, error: requestResult.error };
    }

    const request = requestResult.data;

    switch (request.type) {
      case "pull-events":
        return handlePullEvents(request);
      case "push-events":
        return handlePushEvents(request);
      default:
        request satisfies never;
        return { success: false, error: new Error("Invalid request type") };
    }
  };

  const handlePullEvents = (request: ExtractSyncServerRequest<"pull-events">): MessageResult => {
    const batch = crdtStorage.getEventsBatch({
      limit: bufferSize,
      status: "applied",
      afterSyncId: request.afterSyncId,
      excludeNodeId: request.excludeNodeId ?? "",
    });

    const eventsPullMessage: SyncServerMessage = {
      type: "events-pull-response",
      requestId: request.requestId,
      data: {
        hasMore: batch.hasMore,
        nextSyncId: batch.nextSyncId,
        events: batch.events.map((x) => ({
          schema_version: x.schema_version,
          timestamp: x.timestamp,
          type: x.type,
          dataset: x.dataset,
          item_id: x.item_id,
          payload: x.payload,
        })),
      },
    };

    return {
      success: true,
      payload: JSON.stringify(eventsPullMessage),
    };
  };

  const handlePushEvents = (request: ExtractSyncServerRequest<"push-events">): MessageResult => {
    const { beforeSyncId, afterSyncId } = crdtStorage.enqueueLocalEvents(request.events, request.nodeId);
    const eventsAppliedMessage: SyncServerMessage = {
      type: "events-push-response",
      requestId: request.requestId,
      data: {
        ok: true,
        beforeSyncId,
        afterSyncId,
      },
    };

    return {
      success: true,
      payload: JSON.stringify(eventsAppliedMessage),
    };
  };

  return { handleMessage };
}

function getLatestSyncId(executor: KyselyExecutor<any>) {
  const result = executor.executeKysely((db) =>
    db.selectFrom("crdt_events").select((eb) => eb.fn.max("sync_id").as("sync_id")),
  );
  return result.rows[0]?.sync_id ?? 0;
}

function createReadOnlyCrdtViews(executor: KyselyExecutor<any>, syncDbSchema: SyncDbSchema) {
  executor.transaction((tx) => {
    for (const { baseTableName, crdtTableName } of syncDbSchema.tablesConfig) {
      tx.execute({
        sql: `DROP VIEW IF EXISTS ${quoteId(crdtTableName)}`,
        parameters: [],
      });
      tx.execute({
        sql: `CREATE VIEW ${quoteId(crdtTableName)} AS SELECT * FROM ${quoteId(baseTableName)} WHERE "tombstone" = 0`,
        parameters: [],
      });
    }
  });
}

export const durableObjectAdapter = {
  createCrdtStorage: createDurableObjectCrdtStorage,
};
