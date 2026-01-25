import type { SQLiteReactiveDb } from "../memory-db/sqlite-reactive-db";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
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

  db.execute(
    `
create view ${crdtTableName} as
select * from ${baseTableName}
where tombstone = 0;`,
    { loggerLevel: "system" },
  );

  const allColumnNames = tableSchema.columns.map((column) => column.name);

  const jsonPayload = (from: "new" | "old") =>
    `'{'||${allColumnNames.map((col) => `'"${col}":'||json_quote(${from}.${col})`).join("||','||")}||'}'`;

  db.execute(
    `
create trigger ${crdtTableName}_created
instead of insert on ${crdtTableName}
for each row
begin
select handle_item_created('${baseTableName}', ${jsonPayload("new")});
end;
`,
    { loggerLevel: "system" },
  );

  db.execute(
    `
create trigger ${crdtTableName}_updated
instead of update on ${crdtTableName}
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
create trigger ${crdtTableName}_deleted
instead of delete on ${crdtTableName}
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
