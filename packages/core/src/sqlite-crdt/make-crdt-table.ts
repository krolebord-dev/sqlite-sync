import type { SQLiteReactiveDb } from "../memory-db/sqlite-reactive-db";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { quoteId } from "../utils";
import type { CrdtStorage } from "./crdt-storage";

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

  const columns = new Map(tableSchema.columns.map((c) => [c.name, c]));

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

  db.execute(
    `
create view ${quoteId(crdtTableName)} as
select * from ${quoteId(baseTableName)}
where tombstone = 0;`,
    { loggerLevel: "system" },
  );

  const allColumnNames = tableSchema.columns.map((column) => column.name);

  const jsonPayload = (from: "new" | "old") =>
    `'{'||${allColumnNames.map((col) => `'"${col}":'||json_quote(${from}.${quoteId(col)})`).join("||','||")}||'}'`;

  db.execute(
    `
create trigger ${quoteId(crdtTableName + "_created")}
instead of insert on ${quoteId(crdtTableName)}
for each row
begin
select handle_item_created('${baseTableName}', ${jsonPayload("new")});
end;
`,
    { loggerLevel: "system" },
  );

  db.execute(
    `
create trigger ${quoteId(crdtTableName + "_updated")}
instead of update on ${quoteId(crdtTableName)}
for each row
begin
select handle_item_updated(
  '${baseTableName}',
  ${jsonPayload("old")},
  ${jsonPayload("new")}
);
end;
`,
    { loggerLevel: "system" },
  );

  db.execute(
    `
create trigger ${quoteId(crdtTableName + "_deleted")}
instead of delete on ${quoteId(crdtTableName)}
for each row
when old.tombstone = 0
begin
select handle_item_deleted('${baseTableName}', old.id);
end;
`,
    { loggerLevel: "system" },
  );
}

export function registerCrdtFunctions({
  reactiveDb,
  storage,
}: {
  reactiveDb: SQLiteReactiveDb<any>;
  storage: CrdtStorage;
}) {
  let eventApplied = false;

  reactiveDb.db.createScalarFunction({
    name: "handle_item_created",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, payloadRaw: string) => {
      const payload = JSON.parse(payloadRaw) as { id: string };

      storage.applyOwnEvent(
        {
          type: "item-created",
          dataset,
          item_id: payload.id,
          payload: payloadRaw,
        },
        {
          wrapInTransaction: false,
        },
      );

      eventApplied = true;
      return undefined;
    },
  });

  reactiveDb.db.createScalarFunction({
    name: "handle_item_updated",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, oldPayloadRaw: string, newPayloadRaw: string) => {
      const tableSchema = reactiveDb.db.dbSchema[dataset];
      const oldPayload = JSON.parse(oldPayloadRaw);
      const newPayload = JSON.parse(newPayloadRaw);

      let hasDiff = false;
      const updatePayload = {} as Record<string, unknown>;

      for (const column of tableSchema.columns) {
        const oldValue = oldPayload[column.name];
        const newValue = newPayload[column.name];
        if (oldValue === newValue) {
          continue;
        }
        hasDiff = true;
        updatePayload[column.name] = newValue;
      }

      if (!hasDiff) {
        return;
      }

      storage.applyOwnEvent(
        {
          type: "item-updated",
          dataset,
          item_id: oldPayload.id,
          payload: JSON.stringify(updatePayload),
        },
        {
          wrapInTransaction: false,
        },
      );

      eventApplied = true;
      return undefined;
    },
  });

  reactiveDb.db.createScalarFunction({
    name: "handle_item_deleted",
    deterministic: false,
    directOnly: false,
    innocuous: false,
    callback: (dataset: string, itemId: string) => {
      storage.applyOwnEvent(
        {
          type: "item-updated",
          dataset,
          item_id: itemId,
          payload: JSON.stringify({ tombstone: 1 }),
        },
        {
          wrapInTransaction: false,
        },
      );

      eventApplied = true;
      return undefined;
    },
  });

  reactiveDb.addEventListener("transaction-committed", () => {
    if (eventApplied) {
      eventApplied = false;
      storage.dispatchEventsApplied();
    }
  });

  reactiveDb.addEventListener("transaction-rolled-back", () => {
    eventApplied = false;
  });
}
