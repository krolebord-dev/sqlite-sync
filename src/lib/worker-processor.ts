import sqlite3InitModule, {
  type SAHPoolUtil,
  type Sqlite3Static,
} from "@sqlite.org/sqlite-wasm";
import {
  createBroadcastChannels,
  isWorkerRequestMessage,
  type GetSnapshotResponse,
  type PendingCrdtEvent,
  type PullEventsResponse,
  type WorkerBroadcastChannels,
  type WorkerConfig,
  type WorkerNotificationMessage,
  type WorkerRequestMessage,
  type WorkerRequestMethod,
  type WorkerResponseMessage,
  type WorkerRpc,
} from "./worker-common";
import { sql, type Kysely, type Migration } from "kysely";
import { createSQLiteKysely } from "./sqlite-kysely";
import { createSyncDbMigrator } from "./migrations/migrator";
import type {
  CrdtEventStatus,
  WorkerDbSchema,
} from "./migrations/system-schema";
import {
  SQLiteDbWrapper,
  type ExecuteParams,
  type ExecuteResult,
} from "./sqlite-db-wrapper";
import { logger } from "../logger";
import { applyCrdtEvent } from "./apply-crdt-event";

type WorkerProcessorOptions = {
  nodeId: string;
  dbPath: string;
  broadcastChannels: WorkerBroadcastChannels;
  sqlite3: Sqlite3Static;
  pool: SAHPoolUtil;
  db: SQLiteDbWrapper<WorkerDbSchema>;
  kysely: Kysely<WorkerDbSchema>;
};

export class WorkerProcessor implements WorkerRpc {
  private readonly nodeId: string;
  private readonly dbPath: string;
  private readonly broadcastChannels: WorkerBroadcastChannels;
  private readonly sqlite3: Sqlite3Static;
  private readonly pool: SAHPoolUtil;
  private readonly db: SQLiteDbWrapper<WorkerDbSchema>;
  private readonly kysely: Kysely<WorkerDbSchema>;

  private syncId: number;

  private constructor(opts: WorkerProcessorOptions) {
    this.nodeId = opts.nodeId;
    this.dbPath = opts.dbPath.startsWith("/") ? opts.dbPath : `/${opts.dbPath}`;
    this.broadcastChannels = opts.broadcastChannels;
    this.sqlite3 = opts.sqlite3;
    this.pool = opts.pool;
    this.db = opts.db;
    this.kysely = opts.kysely;

    this.syncId = this.getLatestSyncId();
  }

  execute(query: ExecuteParams): ExecuteResult<unknown> {
    return this.db.execute(query);
  }

  getSnapshot(): GetSnapshotResponse {
    this.db.execute("PRAGMA journal_mode=memory");
    const file = this.sqlite3.capi.sqlite3_js_db_export(this.db.ensureDb);
    this.db.execute("PRAGMA journal_mode=WAL");
    return {
      file,
      syncId: this.syncId,
    };
  }

  pushLocalEvents(
    nodeId: string,
    events: Omit<PendingCrdtEvent, "node_id">[]
  ): void {
    this.db.executeTransaction((db) => {
      const chunkSize = 100;
      for (let i = 0; i < events.length; i += chunkSize) {
        const chunk = events.slice(i, i + chunkSize);
        db.executeKysely((db) =>
          db.insertInto("worker.pending_crdt_events").values(
            chunk.map((x) => ({
              ...x,
              node_id: nodeId,
            }))
          )
        );
      }
    });

    this.startPendingEventsProcessing();
  }

  pullEvents({
    excludeNodeId,
    startFromSyncId,
  }: {
    startFromSyncId: number;
    excludeNodeId: string;
  }): PullEventsResponse {
    const events = this.db.executePrepared(
      "pull-applied-events",
      {
        startFromSyncId,
      },
      (db, params) =>
        db
          .selectFrom("worker.crdt_events")
          .where("sync_id", ">", params("startFromSyncId"))
          .where("status", "=", sql.lit("applied"))
          .selectAll()
          .orderBy("sync_id", "asc")
    );

    if (events.length === 0) {
      return {
        events: [],
        newSyncId: startFromSyncId,
      };
    }

    return {
      events: events.filter((event) => event.node_id !== excludeNodeId),
      newSyncId: events[events.length - 1].sync_id,
    };
  }

  public static async create(
    config: WorkerConfig,
    migrations: Record<number, Migration>
  ) {
    const broadcastChannels = createBroadcastChannels();

    const sqlite3 = await sqlite3InitModule();

    const pool = await sqlite3.installOpfsSAHPoolVfs({
      name: "sync-db-storage",
      clearOnInit: config.clearOnInit,
    });

    const db = new SQLiteDbWrapper<WorkerDbSchema>({
      db: new pool.OpfsSAHPoolDb(config.dbPath),
      logger: logger,
      loggerPrefix: "worker",
    });

    db.execute("PRAGMA locking_mode=exclusive");
    db.execute("PRAGMA journal_mode=WAL");
    db.execute(`ATTACH DATABASE '${config.dbPath}-worker' as worker`);

    const kysely = createSQLiteKysely<WorkerDbSchema>(db);

    const migrator = createSyncDbMigrator({
      db: kysely as Kysely<unknown>,
      migrations,
    });

    await migrator.migrateToLatest();

    const processor = new WorkerProcessor({
      nodeId: config.nodeId,
      dbPath: config.dbPath,
      broadcastChannels,
      sqlite3,
      pool,
      db,
      kysely,
    });

    broadcastChannels.requests.onmessage = (
      event: MessageEvent<Omit<WorkerRequestMessage, "responseType">>
    ) => {
      const message = event.data;

      if (!isWorkerRequestMessage(message)) {
        return;
      }

      processor
        .handleRequest(message)
        .then((data) => {
          const response: WorkerResponseMessage = {
            type: "response",
            requestId: event.data.requestId,
            data,
          };
          broadcastChannels.responses.postMessage(response);
        })
        .catch(console.error);
    };

    return processor;
  }

  async handleRequest<TMethod extends WorkerRequestMethod>(
    message: WorkerRequestMessage<TMethod>
  ): Promise<ReturnType<WorkerRpc[TMethod]>> {
    const method = this[message.method] as () => ReturnType<WorkerRpc[TMethod]>;
    return method.apply(this, message.args as []);
  }

  private pendingEventsProcessingPromise: Promise<void> | undefined;
  private startPendingEventsProcessing() {
    if (this.pendingEventsProcessingPromise) {
      return;
    }
    this.pendingEventsProcessingPromise = this.processPendingCrdtEvents()
      .catch(console.error)
      .finally(() => {
        this.pendingEventsProcessingPromise = undefined;
      });
  }

  private async processPendingCrdtEvents() {
    while (true) {
      await Promise.resolve();
      const events = this.db.executePrepared(
        "pop-pending-crdt-events",
        {
          limit: 50,
        },
        (db, param) =>
          db
            .deleteFrom("worker.pending_crdt_events")
            .where((eb) =>
              eb(
                "id",
                "in",
                eb
                  .selectFrom("worker.pending_crdt_events")
                  .select("id")
                  .limit(param("limit"))
              )
            )
            .returningAll()
      );

      if (events.length === 0) {
        return;
      }

      for (const event of events) {
        let status: CrdtEventStatus = "pending";
        try {
          applyCrdtEvent(this.db, event);

          status = "applied";
        } catch (error) {
          console.error("Error applying pending CRDT event", error);
          status = "failed";
        } finally {
          this.syncId++;
          this.db.executePrepared(
            "insert-crdt-event",
            {
              ...event,
              status,
              sync_id: this.syncId,
            },
            (db, params) =>
              db.insertInto("worker.crdt_events").values({
                id: params("id"),
                status: params("status"),
                type: params("type"),
                dataset: params("dataset"),
                item_id: params("item_id"),
                payload: params("payload"),
                node_id: params("node_id"),
                timestamp: params("timestamp"),
                sync_id: params("sync_id"),
              })
          );

          if (status === "applied") {
            this.postNotification({
              notificationType: "new-event-applied",
              event: {
                ...event,
                sync_id: this.syncId,
              },
            });
          }
        }
      }
    }
  }

  private getLatestSyncId() {
    const result = this.db.executePrepared("get-latest-sync-id", {}, (db) =>
      db
        .selectFrom("worker.crdt_events")
        .select((eb) => eb.fn.max("sync_id").as("sync_id"))
    );
    return result[0]?.sync_id ?? 0;
  }

  private postNotification(notification: WorkerNotificationMessage) {
    this.broadcastChannels.responses.postMessage(notification);
  }
}
