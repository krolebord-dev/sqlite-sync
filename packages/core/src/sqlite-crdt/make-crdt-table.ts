import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";

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
