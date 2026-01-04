import {
  createKyselyExecutor,
  createMigrator,
  type KyselyExecutor,
  type SyncDbMigrator,
} from "@sqlite-sync/cloudflare";
import {
  applyKyselyEventsBatchFilters,
  type CrdtStorage,
  crdtSchema,
  createCrdtStorage,
  createCrdtSyncProducer,
  createStoredValue,
  jsonSafeParse,
  type PersistedCrdtEvent,
} from "@sqlite-sync/core";
import {
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerRequestSchema,
} from "@sqlite-sync/core/server";
import { type Connection, routePartykitRequest, Server } from "partyserver";
import { migrations } from "../migrations";

type EventLogDbSchema = {
  crdt_events: PersistedCrdtEvent;
};

const batchSize = 100;

export class EventLogServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private sqlExecutor: KyselyExecutor<EventLogDbSchema> = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private storage: CrdtStorage = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private migrator: SyncDbMigrator = null!;

  onStart(): void | Promise<void> {
    this.sqlExecutor = createKyselyExecutor(this.ctx.storage.sql);
    this.migrator = createMigrator(this.ctx.storage, migrations);

    this.sqlExecutor.executeKysely((db) => crdtSchema.persistedEventsTable(db.schema, "crdt_events"));
    this.migrator.migrateDbToLatest();

    const syncId = createStoredValue({
      initialValue: this.getLatestSyncId(),
    });

    this.storage = createCrdtStorage({
      syncId,
      migrator: this.migrator,
      applyCrdtEventMutations: () => {},
      persistEvents: (events) => {
        this.ctx.storage.transactionSync(() => {
          for (const event of events) {
            this.sqlExecutor.executeKysely((db) => db.insertInto("crdt_events").values(event));
          }
        });
      },
      getEventsBatch: (opts) => {
        return this.sqlExecutor.executeKysely((db) =>
          applyKyselyEventsBatchFilters(db.selectFrom("crdt_events").selectAll(), {
            ...opts,
            limit: opts.limit ?? batchSize,
          }),
        ).rows;
      },
      updateEvent: (syncId, event) =>
        this.sqlExecutor.executeKysely((db) =>
          db
            .updateTable("crdt_events")
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

    createCrdtSyncProducer({
      bufferSize: 50,
      storage: this.storage,
      broadcastEvents: (chunk) => {
        this.broadcast(
          JSON.stringify({
            type: "events-applied",
            newSyncId: chunk.newSyncId,
          }),
        );
      },
    });
  }

  onMessage(connection: Connection, message: string) {
    const requestRaw = jsonSafeParse<SyncServerRequest>(message);

    if (!requestRaw.success) {
      console.log("Invalid request", requestRaw.error);
      return;
    }

    const requestResult = syncServerRequestSchema.safeParse(requestRaw.data);

    if (!requestResult.success) {
      console.log("Invalid request", requestResult.error);
      return;
    }

    const request = requestResult.data;

    switch (request.type) {
      case "pull-events":
        this.handlePullEvents(connection, request);
        break;
      case "push-events":
        this.handlePushEvents(connection, request);
        break;
      default:
        request satisfies never;
        return;
    }
  }

  private handlePullEvents(connection: Connection, request: ExtractSyncServerRequest<"pull-events">) {
    const batch = this.storage.getEventsBatch({
      limit: batchSize,
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

    connection.send(JSON.stringify(eventsPullMessage));
  }

  private handlePushEvents(connection: Connection, request: ExtractSyncServerRequest<"push-events">) {
    const migratedEvents = request.events
      .map((event) => this.migrator.migrateEvent(event, this.migrator.currentSchemaVersion))
      .filter(Boolean)
      .map((event) => {
        // biome-ignore lint/style/noNonNullAssertion: checked for null
        return { ...event!, origin: request.nodeId };
      });
    this.storage.enqueueEvents(migratedEvents);
    const eventsAppliedMessage: SyncServerMessage = {
      type: "events-push-response",
      requestId: request.requestId,
      data: {
        ok: true,
      },
    };

    connection.send(JSON.stringify(eventsAppliedMessage));
  }

  private getLatestSyncId() {
    const result = this.sqlExecutor.executeKysely((db) =>
      db.selectFrom("crdt_events").select((eb) => eb.fn.max("sync_id").as("sync_id")),
    );
    return result.rows[0]?.sync_id ?? 0;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
