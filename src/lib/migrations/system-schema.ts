import type { Kysely, Migration, ColumnType } from "kysely";

const metaTableName = "sync_db_meta" as const;

export type CrdtEventType = "item-created" | "item-updated";
export type CrdtEventStatus = "pending" | "applied" | "failed";

type PendingCrdtEvent = {
  id: string;
  timestamp: string;
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  payload: string;
  node_id: string;
};

export type WorkerDbSchema = {
  [metaTableName]: {
    id: string;
    data: string;
  };
  ["worker.crdt_events"]: {
    sync_id: ColumnType<number, number | undefined, number | undefined>;
    id: string;
    status: CrdtEventStatus;
    timestamp: string;
    type: CrdtEventType;
    dataset: string;
    item_id: string;
    payload: string;
    node_id: string;
  };
  ["worker.pending_crdt_events"]: PendingCrdtEvent;
};

export type MemoryDbSchema = WorkerDbSchema & {
  pending_crdt_events: Omit<PendingCrdtEvent, "node_id">;
};

export const systemMigration: Migration = {
  async up(db) {
    await db.schema
      .createTable(metaTableName)
      .addColumn("id", "text", (col) => col.primaryKey().notNull())
      .addColumn("data", "text")
      .execute();

    await db.schema
      .createTable("worker.crdt_events")
      .addColumn("sync_id", "integer", (col) =>
        col.primaryKey().autoIncrement()
      )
      .addColumn("id", "text", (col) => col.notNull().unique())
      .addColumn("node_id", "text", (col) => col.notNull())
      .addColumn("status", "text", (col) => col.notNull().defaultTo("pending"))
      .addColumn("timestamp", "text", (col) => col.notNull())
      .addColumn("type", "text", (col) => col.notNull())
      .addColumn("dataset", "text")
      .addColumn("item_id", "text")
      .addColumn("payload", "text", (col) => col.notNull().defaultTo("{}"))
      .execute();

    await createPendingCrdtEventsTable(db, "worker.pending_crdt_events")
      .addColumn("node_id", "text", (col) => col.notNull())
      .execute();
  },
};

export const memoryDbMigration: Migration = {
  async up(db) {
    await createPendingCrdtEventsTable(db, "pending_crdt_events").execute();
  },
};

const createPendingCrdtEventsTable = (
  db: Kysely<unknown>,
  tableName: string
) => {
  return db.schema
    .createTable(tableName)
    .addColumn("id", "text", (col) => col.primaryKey().notNull())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("dataset", "text")
    .addColumn("item_id", "text")
    .addColumn("payload", "text", (col) => col.notNull().defaultTo("{}"));
};
