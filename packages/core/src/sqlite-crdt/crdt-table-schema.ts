import type { SchemaModule } from "kysely";

export type CrdtEventType = "item-created" | "item-updated";

export type CrdtEventStatus = "pending" | "applied" | "failed" | "skipped";

export type CrdtEventOrigin = "remote" | "own" | "local";

export type PersistedCrdtEvent = {
  schema_version: number;
  sync_id: number;
  status: CrdtEventStatus;
  type: CrdtEventType;
  timestamp: string;
  origin: CrdtEventOrigin;
  source_node_id: string;
  dataset: string;
  item_id: string;
  payload: string;
};

export type CrdtUpdateLogItem = {
  dataset: string;
  item_id: string;
  payload: string;
};

export type CrdtUpdateLogPayload = Record<string, string>;

export const crdtSchema = {
  persistedEventsTable: createPersistedEventsTable,
  crdtUpdateLogTable: createCrdtUpdateLogTableQuery,
};

function createPersistedEventsTable(schema: SchemaModule, tableName: string) {
  return schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn("sync_id", "integer", (col) => col.notNull().primaryKey())
    .addColumn("schema_version", "integer", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("origin", "text", (col) => col.notNull())
    .addColumn("dataset", "text", (col) => col.notNull())
    .addColumn("item_id", "text", (col) => col.notNull())
    .addColumn("payload", "text", (col) => col.notNull());
}

function createCrdtUpdateLogTableQuery(schema: SchemaModule, tableName: string) {
  return schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn("dataset", "text", (col) => col.notNull())
    .addColumn("item_id", "text", (col) => col.notNull())
    .addColumn("payload", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint(`pk_${tableName}`, ["item_id", "dataset"]);
}
