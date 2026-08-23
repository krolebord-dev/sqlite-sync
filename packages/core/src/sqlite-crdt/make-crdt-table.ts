import type { SQLiteReactiveDb } from "../memory-db/sqlite-reactive-db";
import type { InternalSQLiteTransactionWrapper, SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { quoteId } from "../utils";
import type { CrdtChangeIntent, InternalCrdtStorage } from "./crdt-storage";

export const CRDT_CHANGE_INTENTS_TABLE = "crdt_change_intents";

export function makeCrdtTable({
  db,
  baseTableName,
  crdtTableName,
}: {
  db: SQLiteDbWrapper<any>;
  baseTableName: string;
  crdtTableName: string;
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
    columnNames: tableSchema.columns.map((column) => column.name),
  })) {
    db.execute(sql, { loggerLevel: "system" });
  }
}

export function createCrdtViewStatements({
  baseTableName,
  crdtTableName,
  columnNames,
}: {
  baseTableName: string;
  crdtTableName: string;
  columnNames: string[];
}) {
  const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const fullPayload = `'{'||${columnNames
    .map((columnName) => `${sqlString(`${JSON.stringify(columnName)}:`)}||json_quote(new.${quoteId(columnName)})`)
    .join("||','||")}||'}'`;
  const updatePayload = `'{'||rtrim(${columnNames
    .filter((columnName) => columnName !== "id")
    .map(
      (columnName) =>
        `case when old.${quoteId(columnName)} collate binary is not new.${quoteId(columnName)} then ${sqlString(
          `${JSON.stringify(columnName)}:`,
        )}||json_quote(new.${quoteId(columnName)})||',' else '' end`,
    )
    .join("||")}, ',')||'}'`;

  return [
    `create table if not exists ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
  "seq" integer primary key,
  "dataset" text not null,
  "type" text not null,
  "item_id" text not null,
  "new_item_id" text,
  "payload_json" text not null
)`,
    `create view ${quoteId(crdtTableName)} as
select * from ${quoteId(baseTableName)}
where tombstone = 0`,
    `create trigger ${quoteId(`${crdtTableName}_created`)}
instead of insert on ${quoteId(crdtTableName)}
for each row
begin
  insert into ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
    "dataset", "type", "item_id", "new_item_id", "payload_json"
  ) values (
    ${sqlString(baseTableName)}, 'item-created', new."id", null, ${fullPayload}
  );
end`,
    `create trigger ${quoteId(`${crdtTableName}_updated`)}
instead of update on ${quoteId(crdtTableName)}
for each row
begin
  insert into ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
    "dataset", "type", "item_id", "new_item_id", "payload_json"
  ) values (
    ${sqlString(baseTableName)}, 'item-updated', old."id", new."id", ${updatePayload}
  );
end`,
    `create trigger ${quoteId(`${crdtTableName}_deleted`)}
instead of delete on ${quoteId(crdtTableName)}
for each row
when old."tombstone" = 0
begin
  insert into ${quoteId(CRDT_CHANGE_INTENTS_TABLE)} (
    "dataset", "type", "item_id", "new_item_id", "payload_json"
  ) values (
    ${sqlString(baseTableName)}, 'item-deleted', old."id", null, '{}'
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
    if (reactiveDb.getTableMutationVersion(CRDT_CHANGE_INTENTS_TABLE) === processedIntentMutationVersion) {
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

  reactiveDb.addEventListener("transaction-committed", () => {
    if (eventApplied) {
      eventApplied = false;
      void storage.internal.processEnqueuedEvents();
    }
  });

  reactiveDb.addEventListener("transaction-rolled-back", () => {
    eventApplied = false;
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
