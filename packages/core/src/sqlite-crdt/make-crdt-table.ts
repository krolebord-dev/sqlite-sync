import type { SQLiteReactiveDb } from "../memory-db/sqlite-reactive-db";
import type { AnyTableBuilder } from "../schema/table-builder";
import type { InternalSQLiteTransactionWrapper, SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { quoteId } from "../utils";
import type { CrdtChangeIntent, InternalCrdtStorage } from "./crdt-storage";

export const CRDT_CHANGE_INTENTS_TABLE = "crdt_change_intents";

export function makeCrdtTable({
  db,
  baseTableName,
  crdtTableName,
  temp,
}: {
  db: SQLiteDbWrapper<any>;
  baseTableName: string;
  crdtTableName: string;
  temp?: boolean;
}) {
  const tableSchema = db.dbSchema[baseTableName];

  if (!tableSchema) {
    throw new Error(`Table ${baseTableName} not found`);
  }

  const columns = new Map(tableSchema.columns.map((column) => [column.name, column]));

  const idColumn = columns.get("id");
  if (!idColumn) {
    throw new Error(
      `Table "${baseTableName}" is missing a required "id" column. CRDT tables must have an "id" column to identify items.`,
    );
  }
  if (idColumn.dataType.toUpperCase() !== "TEXT") {
    throw new Error(
      `Table "${baseTableName}": "id" column must be of type TEXT, got "${idColumn.dataType}". CRDT item IDs are stored as strings.`,
    );
  }

  const tombstoneColumn = columns.get("tombstone");
  if (!tombstoneColumn) {
    throw new Error(
      `Table "${baseTableName}" is missing a required "tombstone" column. CRDT tables must have a "tombstone" INTEGER column for soft deletes.`,
    );
  }
  const tombstoneType = tombstoneColumn.dataType.toUpperCase();
  if (tombstoneType !== "INTEGER" && tombstoneType !== "BOOLEAN") {
    throw new Error(
      `Table "${baseTableName}": "tombstone" column must be of type INTEGER or BOOLEAN, got "${tombstoneColumn.dataType}". It is compared as 0/1 for soft deletes.`,
    );
  }

  for (const sql of createCrdtViewStatements({
    baseTableName,
    crdtTableName,
    columns: tableSchema.columns.map((column) => ({ name: column.name, nullable: column.isNullable })),
    temp,
  })) {
    db.execute(sql, { loggerLevel: "system" });
  }
}

// Workerd caps expr depth at 100; a left-deep `||` chain fails around 34 columns.
function concatSql(parts: readonly string[]): string {
  if (parts.length === 0) {
    return "''";
  }
  if (parts.length === 1) {
    return parts[0];
  }
  const mid = parts.length >> 1;
  return `(${concatSql(parts.slice(0, mid))})||(${concatSql(parts.slice(mid))})`;
}

function sqlStringLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

export type CrdtViewColumn = {
  name: string;
  nullable: boolean;
};

export function crdtViewColumnsFromTable(table: AnyTableBuilder): CrdtViewColumn[] {
  return Object.entries(table.columns).map(([name, meta]) => ({ name, nullable: meta.nullable }));
}

// Columns omitted from an insert are NULL in an INSTEAD OF trigger. NULLs of NOT NULL columns are
// left out of the payload so applying it falls back to the table DEFAULT on every replica.
// The tombstone is left out: applying a create always sets it to 0.
function createdPayloadSql(columns: CrdtViewColumn[]) {
  const fields = columns
    .filter((column) => column.name !== "tombstone")
    .map((column) => {
      const quoted = quoteId(column.name);
      const field = `${sqlStringLiteral(`${JSON.stringify(column.name)}:`)}||json_quote(new.${quoted})||','`;
      return column.nullable ? field : `case when new.${quoted} is null then '' else ${field} end`;
    });
  return concatSql(["'{'", `rtrim(${concatSql(fields)}, ',')`, "'}'"]);
}

function sparseUpdatePayloadSql(columnNames: string[]) {
  const changedFields = columnNames
    .filter((columnName) => columnName !== "id")
    .map((columnName) => {
      const quoted = quoteId(columnName);
      const key = sqlStringLiteral(`${JSON.stringify(columnName)}:`);
      return `case when old.${quoted} collate binary is not new.${quoted} then ${key}||json_quote(new.${quoted})||',' else '' end`;
    });
  return concatSql(["'{'", `rtrim(${concatSql(changedFields)}, ',')`, "'}'"]);
}

export function createCrdtViewStatements({
  baseTableName,
  crdtTableName,
  columns,
  temp = false,
}: {
  baseTableName: string;
  crdtTableName: string;
  columns: CrdtViewColumn[];
  /**
   * Create the view, its triggers and the intents table in the connection's temp schema,
   * so a persisted database never stores them and they always match the current schema.
   */
  temp?: boolean;
}) {
  const createdPayload = createdPayloadSql(columns);
  const updatePayload = sparseUpdatePayloadSql(columns.map((column) => column.name));
  const tempKeyword = temp ? "temp " : "";

  return [
    `create ${tempKeyword}table if not exists ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
  "seq" integer primary key,
  "dataset" text not null,
  "type" text not null,
  "item_id" text not null,
  "new_item_id" text,
  "payload_json" text not null
)`,
    `create ${tempKeyword}view ${quoteId(crdtTableName)} as
select * from ${quoteId(baseTableName)}
where tombstone = 0`,
    `create ${tempKeyword}trigger ${quoteId(`${crdtTableName}_created`)}
instead of insert on ${quoteId(crdtTableName)}
for each row
begin
  insert into ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
    "dataset", "type", "item_id", "new_item_id", "payload_json"
  ) values (
    ${sqlStringLiteral(baseTableName)}, 'item-created', new."id", null, ${createdPayload}
  );
end`,
    `create ${tempKeyword}trigger ${quoteId(`${crdtTableName}_updated`)}
instead of update on ${quoteId(crdtTableName)}
for each row
begin
  insert into ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
    "dataset", "type", "item_id", "new_item_id", "payload_json"
  ) values (
    ${sqlStringLiteral(baseTableName)}, 'item-updated', old."id", new."id", ${updatePayload}
  );
end`,
    `create ${tempKeyword}trigger ${quoteId(`${crdtTableName}_deleted`)}
instead of delete on ${quoteId(crdtTableName)}
for each row
when old."tombstone" = 0
begin
  insert into ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
    "dataset", "type", "item_id", "new_item_id", "payload_json"
  ) values (
    ${sqlStringLiteral(baseTableName)}, 'item-deleted', old."id", null, '{}'
  );
end`,
  ];
}

export function registerCrdtIntentDrainer({
  reactiveDb,
  storage,
}: {
  reactiveDb: SQLiteReactiveDb<any>;
  storage: InternalCrdtStorage;
}) {
  let eventApplied = false;
  let processedIntentMutationVersion = reactiveDb.getTableMutationVersion(CRDT_CHANGE_INTENTS_TABLE);

  reactiveDb.db.setAfterMutatingStatement((tx) => {
    if (
      reactiveDb.hasSynchronousHooks &&
      reactiveDb.getTableMutationVersion(CRDT_CHANGE_INTENTS_TABLE) === processedIntentMutationVersion
    ) {
      return;
    }

    try {
      if (drainCrdtChangeIntents({ tx, storage })) {
        eventApplied = true;
      }
    } finally {
      processedIntentMutationVersion = reactiveDb.getTableMutationVersion(CRDT_CHANGE_INTENTS_TABLE);
    }
  });

  // A rolled-back drain leaves `eventApplied` set on purpose: with asynchronous hooks the
  // rollback can be delivered after a later transaction drained again, and clearing the flag
  // then would strand that transaction's events. Processing with nothing pending is a no-op.
  reactiveDb.addEventListener("transaction-committed", () => {
    if (eventApplied) {
      eventApplied = false;
      void storage.internal.processEnqueuedEvents();
    }
  });
}

export function drainCrdtChangeIntents({
  tx,
  storage,
}: {
  tx: InternalSQLiteTransactionWrapper<any>;
  storage: InternalCrdtStorage;
}) {
  const intents = tx.executePreparedRaw<[], CrdtChangeIntent>({
    key: "drain-crdt-change-intents",
    sql: `delete from ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} returning *`,
    meta: { loggerLevel: "system" },
  });
  intents.sort((a, b) => a.seq - b.seq);

  const { appliedEvents } = storage.internal.applyOwnIntentsFromTransaction(tx, intents);
  return appliedEvents > 0;
}
