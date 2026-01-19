import {
  applyKyselyEventsBatchFilters,
  type CrdtStorage,
  crdtSchema,
  createCrdtStorage,
  createCrdtSyncProducer,
  createStoredValue,
  jsonSafeParse,
  type Migrations,
  type PersistedCrdtEvent,
} from "@sqlite-sync/core";
import {
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerZodSchema,
} from "@sqlite-sync/core/server";
import { createKyselyExecutor, type KyselyExecutor } from "./kysely-executor";
import { createMigrator, type SyncDbMigrator } from "./migrator";

type AdapterDb = {
  crdtEvents: PersistedCrdtEvent;
};

function createDurableObjectCrdtStorage<Database>({
  storage,
  migrations,
  crdtEventsTable = "crdt_events",
  batchSize = 50,
}: {
  storage: DurableObjectStorage;
  migrations: Migrations;
  crdtEventsTable: string;
  batchSize?: number;
}): {
  crdtStorage: CrdtStorage;
  sqlExecutor: KyselyExecutor<Database>;
  migrator: SyncDbMigrator;
} {
  const sqlExecutor = createKyselyExecutor<AdapterDb>(storage.sql);
  sqlExecutor.executeKysely((db) => crdtSchema.persistedEventsTable(db.schema, crdtEventsTable));

  const migrator = createMigrator(storage, migrations);
  migrator.migrateDbToLatest();

  const syncId = createStoredValue({
    initialValue: getLatestSyncId(sqlExecutor),
  });

  const crdtStorage = createCrdtStorage({
    syncId,
    migrator: migrator,
    applyCrdtEventMutations: () => {},
    persistEvents: (events) => {
      storage.transactionSync(() => {
        for (const event of events) {
          sqlExecutor.executeKysely((db) => db.insertInto(crdtEventsTable as "crdtEvents").values(event));
        }
      });
    },
    getEventsBatch: (opts) => {
      return sqlExecutor.executeKysely((db) =>
        applyKyselyEventsBatchFilters(db.selectFrom(crdtEventsTable as "crdtEvents").selectAll(), {
          ...opts,
          limit: opts.limit ?? batchSize,
        }),
      ).rows;
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
    crdtStorage.enqueueEvents(request.events.map((event) => ({ ...event, origin: request.nodeId })));
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
