import type { SchemaModule } from "kysely";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import type { TableMetadata } from "../introspection";
import {
  applyCrdtEventMutations,
  type PendingCrdtEvent,
} from "./apply-crdt-event";

export type CrdtEventType = "item-created" | "item-updated";

export type CrdtEventStatus = "applied" | "failed";

export type PersistedCrdtEvent = {
  id: string;
  type: CrdtEventType;
  timestamp: string;
  node_id: string;
  dataset: string;
  item_id: string;
  payload: string;
};

export type AppliedCrdtEvent = {
  sync_id: number;
  status: CrdtEventStatus;
  type: CrdtEventType;
  timestamp: string;
  node_id: string;
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
  pendingEventsTable: createPendingEventsTableQuery,
  appliedEventsTable: createAppliedEventsTableQuery,
  crdtUpdateLogTable: createCrdtUpdateLogTableQuery,
};

function createPendingEventsTableQuery(
  schema: SchemaModule,
  tableName: string
) {
  return createBaseEventsTableQuery(schema, tableName).addColumn(
    "id",
    "text",
    (col) => col.notNull().primaryKey()
  );
}

function createAppliedEventsTableQuery(
  schema: SchemaModule,
  tableName: string
) {
  return createBaseEventsTableQuery(schema, tableName)
    .addColumn("sync_id", "integer", (col) => col.notNull().primaryKey())
    .addColumn("status", "text", (col) => col.notNull());
}

function createBaseEventsTableQuery(schema: SchemaModule, tableName: string) {
  return schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn("type", "text", (col) => col.notNull())
    .addColumn("timestamp", "text", (col) => col.notNull())
    .addColumn("node_id", "text", (col) => col.notNull())
    .addColumn("dataset", "text", (col) => col.notNull())
    .addColumn("item_id", "text", (col) => col.notNull())
    .addColumn("payload", "text", (col) => col.notNull());
}

function createCrdtUpdateLogTableQuery(
  schema: SchemaModule,
  tableName: string
) {
  return schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn("dataset", "text", (col) => col.notNull())
    .addColumn("item_id", "text", (col) => col.notNull())
    .addColumn("payload", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_${tableName}", ["dataset", "item_id"]);
}

export function registerCrdtFunctions({
  db,
  onItemCreated,
  onItemUpdated,
  onItemDeleted,
  onEventApplied,
  getNextTimestamp,
  getTableSchema,
  updateLogTableName,
}: {
  db: SQLiteDbWrapper<any>;
  onItemCreated?: (dataset: string, payload: Record<string, unknown>) => void;
  onItemUpdated?: (
    dataset: string,
    oldPayload: Record<string, unknown>,
    newPayload: Record<string, unknown>
  ) => void;
  onItemDeleted?: (dataset: string, itemId: string) => void;
  onEventApplied?: (event: PendingCrdtEvent) => void;
  getNextTimestamp: () => string;
  getTableSchema: (dataset: string) => TableMetadata;
  updateLogTableName: string;
}) {
  db.createScalarFunction({
    name: "handle_item_created",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, payloadRaw: string) => {
      const payload = JSON.parse(payloadRaw);

      const event: PendingCrdtEvent = {
        timestamp: getNextTimestamp(),
        type: "item-created",
        dataset,
        item_id: payload.id,
        payload,
      };

      applyCrdtEventMutations({
        db,
        event,
        updateLogTableName,
      });

      onItemCreated?.(dataset, payload);
      onEventApplied?.(event);
    },
  });

  db.createScalarFunction({
    name: "handle_item_updated",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (
      dataset: string,
      oldPayloadRaw: string,
      newPayloadRaw: string
    ) => {
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
          .filter(Boolean)
      );

      const event: PendingCrdtEvent = {
        timestamp: getNextTimestamp(),
        type: "item-updated",
        dataset,
        item_id: oldPayload.id,
        payload,
      };

      if (!hasDiff) {
        return;
      }

      applyCrdtEventMutations({
        db,
        event,
        updateLogTableName,
      });
      onItemUpdated?.(dataset, oldPayload, newPayload);
      onEventApplied?.(event);
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
        payload: { tombstone: 1 },
      };

      applyCrdtEventMutations({
        db,
        event,
        updateLogTableName,
      });
      onItemDeleted?.(dataset, itemId);
      onEventApplied?.(event);
    },
  });
}
