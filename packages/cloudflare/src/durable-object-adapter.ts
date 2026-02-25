import {
  applyKyselyEventsBatchFilters,
  type CrdtEventOrigin,
  type CrdtEventStatus,
  type CrdtEventType,
  type CrdtStorage,
  type CrdtStorageMutator,
  type CrdtUpdateLogItem,
  type CrdtUpdateLogPayload,
  createCrdtApplyFunction,
  createCrdtStorage,
  createCrdtStorageMutator,
  createCrdtSyncProducer,
  createStoredValue,
  createTypedEventTarget,
  HLCCounter,
  jsonSafeParse,
  quoteId,
  type PersistedCrdtEvent,
  runSystemMigrations,
  type SyncDbSchema,
  type TypedEventTarget,
} from "@sqlite-sync/core";
import {
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerZodSchema,
} from "@sqlite-sync/core/server";
import { createKyselyExecutor, type KyselyExecutor } from "./kysely-executor";
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
  CrdtStorageMutator<Schema[`~mutationsSchema`]> &
  Pick<TypedEventTarget<ServerSyncDbEvents<Schema>>, "addEventListener" | "removeEventListener">;

function createDurableObjectCrdtStorage<Schema extends SyncDbSchema>({
  storage,
  syncDbSchema,
  crdtEventsTable = "crdt_events",
  batchSize = 50,
  broadcastPayload,
}: {
  storage: DurableObjectStorage;
  syncDbSchema: Schema;
  crdtEventsTable: string;
  batchSize?: number;
  broadcastPayload: (payload: string) => void;
}): {
  syncDb: ServerSyncDb<Schema>;
  remoteHandler: RemoteHandler;
} {
  const eventTarget = createTypedEventTarget<ServerSyncDbEvents<Schema>>();
  const sqlExecutor = createKyselyExecutor<AdapterDb>(storage);

  runSystemMigrations({
    version: createStoredValue<number>({
      initialValue: storage.kv.get("internal-schema-version") ?? -1,
      saveToStorage: (val) => storage.kv.put("internal-schema-version", val),
    }),
    eventsTableName: quoteId(crdtEventsTable),
    updateLogTableName: quoteId(updateLogTableName),
    execute: (sql) => sqlExecutor.execute({ sql, parameters: [] }),
    transaction: (callback) => sqlExecutor.transaction(callback),
  });

  const syncId = createStoredValue({
    initialValue: getLatestSyncId(sqlExecutor),
  });

  const migrator = createMigrator(storage.kv, sqlExecutor, syncDbSchema.migrations);
  migrator.migrateDbToLatest();

  const baseApply = createCrdtApplyFunction({
    getCrdtUpdateLog(opts) {
      const [metaRow] = sqlExecutor.executeKysely((db) =>
        db
          .selectFrom(updateLogTableName)
          .select("payload")
          .where("item_id", "=", opts.itemId)
          .where("dataset", "=", opts.dataset),
      ).rows;
      return metaRow ? (JSON.parse(metaRow.payload) as CrdtUpdateLogPayload) : null;
    },
    insertCrdtUpdateLog(opts) {
      sqlExecutor.executeKysely((db) =>
        db.insertInto(updateLogTableName).values({
          item_id: opts.itemId,
          dataset: opts.dataset,
          payload: opts.payload,
        }),
      );
    },
    updateCrdtUpdateLog(opts) {
      sqlExecutor.executeKysely((db) =>
        db
          .updateTable(updateLogTableName)
          .set({
            payload: opts.payload,
          })
          .where("item_id", "=", opts.itemId)
          .where("dataset", "=", opts.dataset),
      );
    },
    insertItem(opts) {
      sqlExecutor.executeKysely((db) => db.insertInto(opts.dataset as any).values(opts.payload));
    },
    updateItem(opts) {
      const keys = Array.from(Object.keys(opts.payload));
      sqlExecutor.execute({
        sql: `update ${quoteId(opts.dataset)} set ${keys.map((key) => `${quoteId(key)} = ?`).join(",")} where id = ?`,
        parameters: [...keys.map((key) => opts.payload[key]), opts.itemId],
      });
    },
  });

  const handleCrdtEventApply = (event: PersistedCrdtEvent) => {
    sqlExecutor.transaction(() => {
      baseApply(event);
    });

    queueMicrotask(() => {
      eventTarget.dispatchEvent("event-applied", event as TypedPersistedCrdtEvent<Schema>);
    });
  };

  const hlc = new HLCCounter("root", () => Date.now());

  const crdtStorage = createCrdtStorage({
    nodeId: "root",
    syncId,
    hlc,
    migrator: migrator,
    handleCrdtEventApply,
    transaction: (callback) => sqlExecutor.transaction(callback),
    getEventsBatch: (opts) => {
      return sqlExecutor.executeKysely((db) =>
        applyKyselyEventsBatchFilters(db.selectFrom(crdtEventsTable as "crdtEvents").selectAll(), {
          ...opts,
          limit: opts.limit ?? batchSize,
        }),
      ).rows;
    },
    persistEvent: (event) => {
      sqlExecutor.executeKysely((db) => db.insertInto(crdtEventsTable as "crdtEvents").values(event));
    },
    updateEvent: (syncId, event) =>
      sqlExecutor.executeKysely((db) =>
        db
          .updateTable(crdtEventsTable as "crdtEvents")
          .set({
            status: event.status,
            dataset: event.dataset,
            item_id: event.item_id,
            schema_version: event.schema_version,
            type: event.type,
            payload: event.payload,
          })
          .where("sync_id", "=", syncId),
      ),
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
      excludeNodeId: request.excludeNodeId,
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
    crdtStorage.enqueueLocalEvents(request.events, request.nodeId);
    const eventsAppliedMessage: SyncServerMessage = {
      type: "events-push-response",
      requestId: request.requestId,
      data: {
        ok: true,
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

export const durableObjectAdapter = {
  createCrdtStorage: createDurableObjectCrdtStorage,
};
