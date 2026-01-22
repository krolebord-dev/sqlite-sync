import {
  applyKyselyEventsBatchFilters,
  type CrdtStorage,
  type CrdtUpdateLogItem,
  type CrdtUpdateLogPayload,
  crdtSchema,
  createCrdtApplyFunction,
  createCrdtStorage,
  createCrdtSyncProducer,
  createStoredValue,
  HLCCounter,
  jsonSafeParse,
  type PersistedCrdtEvent,
  type SyncDbSchema,
} from "@sqlite-sync/core";
import {
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerZodSchema,
} from "@sqlite-sync/core/server";
import { createKyselyExecutor, type KyselyExecutor } from "./kysely-executor";
import { createMigrator, type SyncDbMigrator } from "./migrator";

const updateLogTableName = "__crdt_update_log";

type AdapterDb = {
  crdtEvents: PersistedCrdtEvent;
  [updateLogTableName]: CrdtUpdateLogItem;
};

export type AdapterMode = "store-event-log-only" | "apply-events";

function createDurableObjectCrdtStorage<Database>({
  storage,
  syncDbSchema,
  crdtEventsTable = "crdt_events",
  batchSize = 50,
  mode,
}: {
  storage: DurableObjectStorage;
  syncDbSchema: SyncDbSchema<unknown, Database>;
  crdtEventsTable: string;
  batchSize?: number;
  mode: AdapterMode;
}): {
  crdtStorage: CrdtStorage;
  sqlExecutor: KyselyExecutor<Database>;
  migrator: SyncDbMigrator;
} {
  const sqlExecutor = createKyselyExecutor<AdapterDb>(storage.sql);

  sqlExecutor.executeKysely((db) => crdtSchema.persistedEventsTable(db.schema, crdtEventsTable));

  const syncId = createStoredValue({
    initialValue: getLatestSyncId(sqlExecutor),
  });

  const migrator = createMigrator(mode, storage, syncDbSchema.migrations);

  let handleCrdtEventApply: (event: PersistedCrdtEvent) => void = () => {};

  if (mode === "apply-events") {
    sqlExecutor.executeKysely((db) => crdtSchema.crdtUpdateLogTable(db.schema, updateLogTableName));
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
          sql: `update ${opts.dataset} set ${keys.map((key) => `${key} = ?`).join(",")} where id = ?`,
          parameters: [...keys.map((key) => opts.payload[key]), opts.itemId],
        });
      },
    });

    handleCrdtEventApply = (event) => {
      storage.transactionSync(() => {
        baseApply(event);
      });
    };
  }

  const hlc = new HLCCounter("root", () => Date.now());

  const crdtStorage = createCrdtStorage({
    syncId,
    hlc,
    migrator: migrator,
    handleCrdtEventApply,
    transaction: (callback) => storage.transactionSync(callback),
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

  return {
    crdtStorage,
    sqlExecutor: sqlExecutor as unknown as KyselyExecutor<Database>,
    migrator,
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
    bufferSize,
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
      excludeOrigin: request.excludeNodeId,
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
    crdtStorage.enqueueLocalEvents(request.events.map((event) => ({ ...event, origin: request.nodeId })));
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
  createRemoteHandler: createDurableObjectRemoteHandler,
};
