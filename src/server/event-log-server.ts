import { routePartykitRequest, Server, type Connection } from "partyserver";
import type {
  ExecuteParams,
  ExecuteResult,
  KyselyQueryFactory,
  QueryBuilderOutput,
} from "../lib/sqlite-db-wrapper";
import type { Compilable } from "kysely";
import { dummyKysely } from "../lib/dummy-kysely";
import {
  crdtSchema,
  type PersistedCrdtEvent,
} from "../lib/sqlite-crdt/crdt-table-schema";
import {
  syncServerRequestSchema,
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
} from "../lib/server/server-common";
import {
  createCrdtStorage,
  type CrdtStorage,
} from "../lib/sqlite-crdt/crdt-storage";
import { createSyncIdCounter } from "../lib/sqlite-crdt/sync-id-counter";
import { createCrdtSyncProducer } from "../lib/sqlite-crdt/crdt-sync-producer";
import { jsonSafeParse } from "../lib/utils";

function createKyselyExecutor<TDatabase>(db: SqlStorage) {
  return {
    execute<TResult = unknown>(query: ExecuteParams): ExecuteResult<TResult> {
      const rows = db.exec(query.sql, ...query.parameters).toArray();
      return { rows: rows as TResult[] };
    },
    executeKysely<
      TQuery extends Compilable<TResult>,
      TResult = QueryBuilderOutput<TQuery>
    >(
      factory: KyselyQueryFactory<TDatabase, TQuery, TResult>
    ): ExecuteResult<TResult> {
      const query = factory(dummyKysely).compile();
      return this.execute(query);
    },
  };
}

type SqlExecutor<TDatabase> = ReturnType<
  typeof createKyselyExecutor<TDatabase>
>;

type EventLogDbSchema = {
  crdt_events: PersistedCrdtEvent;
};

const batchSize = 50;

export class EventLogServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  private sqlExecutor: SqlExecutor<EventLogDbSchema> = null!;
  private storage: CrdtStorage = null!;

  onStart(): void | Promise<void> {
    this.sqlExecutor = createKyselyExecutor(this.ctx.storage.sql);

    this.sqlExecutor.executeKysely((db) =>
      crdtSchema.persistedEventsTable(db.schema, "crdt_events")
    );

    const syncId = createSyncIdCounter({
      initialSyncId: this.getLatestSyncId(),
    });

    this.storage = createCrdtStorage({
      syncId,
      applyCrdtEventMutations: () => {},
      persistEvents: (events) => {
        this.ctx.storage.transactionSync(() => {
          for (const event of events) {
            this.sqlExecutor.executeKysely((db) =>
              db.insertInto("crdt_events").values(event)
            );
          }
        });
      },
      popPendingEventsBatch: () => {
        const events = this.sqlExecutor.executeKysely((db) =>
          db
            .selectFrom("crdt_events")
            .where("status", "=", "pending")
            .orderBy("sync_id", "asc")
            .limit(batchSize)
            .selectAll()
        ).rows;
        return {
          events,
          hasMore: events.length === batchSize,
        };
      },
      updateEventStatus: (syncId, status) =>
        this.sqlExecutor.executeKysely((db) =>
          db
            .updateTable("crdt_events")
            .set({ status })
            .where("sync_id", "=", syncId)
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
          })
        );
      },
    });
  }

  onMessage(connection: Connection, message: string) {
    const requestRaw = jsonSafeParse<SyncServerRequest>(message);

    if (requestRaw.status !== "ok") {
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

  private handlePullEvents(
    connection: Connection,
    request: ExtractSyncServerRequest<"pull-events">
  ) {
    const events = this.sqlExecutor.executeKysely((db) => {
      const query = db
        .selectFrom("crdt_events")
        .where("sync_id", ">", request.afterSyncId)
        .where("status", "=", "applied")
        .orderBy("sync_id", "asc")
        .limit(batchSize)
        .selectAll();
      return query;
    }).rows;
    const eventsPullMessage: SyncServerMessage = {
      type: "events-pull-response",
      requestId: request.requestId,
      data: {
        events: request.excludeNodeId
          ? events.filter((x) => x.origin !== request.excludeNodeId)
          : events,
        hasMore: events.length === batchSize,
        newSyncId: events[events.length - 1]?.sync_id ?? request.afterSyncId,
      },
    };

    connection.send(JSON.stringify(eventsPullMessage));
  }

  private handlePushEvents(
    connection: Connection,
    request: ExtractSyncServerRequest<"push-events">
  ) {
    this.storage.enqueueEvents(
      request.events.map((x) => ({ ...x, origin: request.nodeId }))
    );
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
      db
        .selectFrom("crdt_events")
        .select((eb) => eb.fn.max("sync_id").as("sync_id"))
    );
    return result.rows[0]?.sync_id ?? 0;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(
        request,
        env as unknown as Record<string, unknown>
      )) || new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
