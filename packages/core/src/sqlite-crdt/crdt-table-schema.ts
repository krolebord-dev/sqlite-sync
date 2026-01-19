import type { SchemaModule } from "kysely";
import type { TableMetadata } from "../introspection";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createSQLiteCrdtApplyFunction, type PendingCrdtEvent } from "./apply-crdt-event";

export type CrdtEventType = "item-created" | "item-updated";

export type CrdtEventStatus = "pending" | "applied" | "failed" | "skipped";

export type CrdtEventOrigin = "remote" | (string & {});

export type PersistedCrdtEvent = {
  schema_version: number;
  sync_id: number;
  status: CrdtEventStatus;
  type: CrdtEventType;
  timestamp: string;
  origin: CrdtEventOrigin;
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

export function registerCrdtFunctions({
  db,
  onEventApplied,
  getNextTimestamp,
  getTableSchema,
  updateLogTableName,
}: {
  db: SQLiteDbWrapper<any>;
  onEventApplied: (event: PendingCrdtEvent) => void;
  getNextTimestamp: () => string;
  getTableSchema: (dataset: string) => TableMetadata;
  updateLogTableName: string;
}) {
  const applyCrdtEventMutations = createSQLiteCrdtApplyFunction({
    db,
    updateLogTableName,
    wrapInSavepoint: false,
  });

  db.createScalarFunction({
    name: "handle_item_created",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, payloadRaw: string) => {
      const payload = JSON.parse(payloadRaw) as { id: string };

      const event: PendingCrdtEvent = {
        timestamp: getNextTimestamp(),
        type: "item-created",
        dataset,
        item_id: payload.id,
        payload: payloadRaw,
      };

      applyCrdtEventMutations(event);
      onEventApplied(event);
      return undefined;
    },
  });

  db.createScalarFunction({
    name: "handle_item_updated",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, oldPayloadRaw: string, newPayloadRaw: string) => {
      const tableSchema = getTableSchema(dataset);
      const oldPayload = JSON.parse(oldPayloadRaw);
      const newPayload = JSON.parse(newPayloadRaw);

      let hasDiff = false;
      const payload = Object.fromEntries(
        tableSchema.columns
          .map((column) => {
            const oldValue = oldPayload[column.name];
            const newValue = newPayload[column.name];
            if (oldValue === newValue) {
              return null as unknown as [string, unknown];
            }
            hasDiff = true;
            return [column.name, newValue] as const;
          })
          .filter(Boolean),
      );

      const event: PendingCrdtEvent = {
        timestamp: getNextTimestamp(),
        type: "item-updated",
        dataset,
        item_id: oldPayload.id,
        payload: JSON.stringify(payload),
      };

      if (!hasDiff) {
        return;
      }

      applyCrdtEventMutations(event);
      onEventApplied(event);
      return undefined;
    },
  });

  db.createScalarFunction({
    name: "handle_item_deleted",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, itemId: string) => {
      const event: PendingCrdtEvent = {
        timestamp: getNextTimestamp(),
        type: "item-updated",
        dataset,
        item_id: itemId,
        payload: JSON.stringify({ tombstone: 1 }),
      };

      applyCrdtEventMutations(event);
      onEventApplied(event);
      return undefined;
    },
  });
}
