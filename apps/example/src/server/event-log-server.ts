import {
  applyKyselyEventsBatchFilters,
  type CrdtStorage,
  crdtSchema,
  createCrdtStorage,
  createCrdtSyncProducer,
  createSyncIdCounter,
  dummyKysely,
  type ExtractSyncServerRequest,
  jsonSafeParse,
  type PersistedCrdtEvent,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerRequestSchema,
} from "@sqlite-sync/core/server";
import type { Compilable, Kysely } from "kysely";
import { type Connection, routePartykitRequest, Server } from "partyserver";

type ExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

type ExecuteResult<T> = {
  rows: T[];
};

type QueryBuilderOutput<QB> = QB extends Compilable<infer O> ? O : never;

type KyselyQueryFactory<TDatabase, TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>> = (
  kysely: Kysely<TDatabase>,
) => TQuery;

function createKyselyExecutor<TDatabase>(db: SqlStorage) {
  return {
    execute<TResult = unknown>(query: ExecuteParams): ExecuteResult<TResult> {
      const rows = db.exec(query.sql, ...query.parameters).toArray();
      return { rows: rows as TResult[] };
    },
    executeKysely<TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
      factory: KyselyQueryFactory<TDatabase, TQuery, TResult>,
    ): ExecuteResult<TResult> {
      const query = factory(dummyKysely).compile();
      return this.execute(query);
    },
  };
}

type SqlExecutor<TDatabase> = ReturnType<typeof createKyselyExecutor<TDatabase>>;

type EventLogDbSchema = {
  crdt_events: PersistedCrdtEvent;
};

const batchSize = 100;

export class EventLogServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private sqlExecutor: SqlExecutor<EventLogDbSchema> = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private storage: CrdtStorage = null!;

  onStart(): void | Promise<void> {
    this.sqlExecutor = createKyselyExecutor(this.ctx.storage.sql);

    this.sqlExecutor.executeKysely((db) => crdtSchema.persistedEventsTable(db.schema, "crdt_events"));

    const syncId = createSyncIdCounter({
      initialSyncId: this.getLatestSyncId(),
    });

    this.storage = createCrdtStorage({
      syncId,
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
      updateEventStatus: (syncId, status) =>
        this.sqlExecutor.executeKysely((db) =>
          db.updateTable("crdt_events").set({ status }).where("sync_id", "=", syncId),
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
    this.storage.enqueueEvents(request.events.map((x) => ({ ...x, origin: request.nodeId })));
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
