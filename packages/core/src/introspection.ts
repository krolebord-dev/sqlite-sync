import type { Kysely } from "kysely";
import type { QueryCreator } from "kysely";
import { sql } from "kysely";
import type { SQLiteDbWrapper } from "./sqlite-db-wrapper";

interface SqliteSystemDatabase {
  // https://www.sqlite.org/schematab.html#alternative_names
  sqlite_master: SQliteMasterTable;
}

// https://www.sqlite.org/schematab.html#interpretation_of_the_schema_table
interface SQliteMasterTable {
  name: string;
  rootpage: number | null;
  sql: string;
  tbl_name: string;
  type: "index" | "table" | "trigger" | "view";
}

// https://www.sqlite.org/pragma.html#pragma_table_info
interface PragmaTableInfo {
  cid: number;
  dflt_value: unknown;
  name: string;
  notnull: 0 | 1;
  pk: number;
  type: string;
}

function tablesQuery(
  qb: QueryCreator<SqliteSystemDatabase> | Kysely<SqliteSystemDatabase>
) {
  return qb
    .selectFrom("sqlite_master")
    .where("type", "in", ["table", "view"])
    .where("name", "not like", "sqlite_%")
    .select(["name", "sql", "type"])
    .orderBy("name");
}

export type TableMetadata = {
  name: string;
  isView: boolean;
  columns: ColumnMetadata[];
};

export type DatabaseIntrospection = Record<string, TableMetadata>;

type ColumnMetadata = {
  name: string;
  dataType: string;
  isNullable: boolean;
  isAutoIncrementing: boolean;
  hasDefaultValue: boolean;
  comment: undefined;
};

export function introspectDb<BaseDatabase>(
  _db: SQLiteDbWrapper<BaseDatabase>
): DatabaseIntrospection {
  const db = _db as unknown as SQLiteDbWrapper<SqliteSystemDatabase>;
  const tables = db.executeKysely((db) =>
    tablesQuery(db as unknown as Kysely<SqliteSystemDatabase>)
  ).rows;

  const tablesMetadata = db.executeKysely((db) =>
    db
      .with("table_list", (qb) =>
        tablesQuery(qb as unknown as Kysely<SqliteSystemDatabase>)
      )
      .selectFrom([
        "table_list as tl",
        sql<PragmaTableInfo>`pragma_table_info(tl.name)`.as("p"),
      ])
      .select([
        "tl.name as table",
        "p.cid",
        "p.name",
        "p.type",
        "p.notnull",
        "p.dflt_value",
        "p.pk",
      ])
      .orderBy("tl.name")
      .orderBy("p.cid")
  ).rows;

  const columnsByTable: Record<string, typeof tablesMetadata> = {};
  for (const row of tablesMetadata) {
    columnsByTable[row.table] ??= [];
    columnsByTable[row.table].push(row);
  }

  return Object.fromEntries(
    tables.map(({ name, sql, type }) => {
      // // Try to find the name of the column that has `autoincrement` 🤦
      let autoIncrementCol = sql
        ?.split(/[(),]/)
        ?.find((it) => it.toLowerCase().includes("autoincrement"))
        ?.trimStart()
        ?.split(/\s+/)?.[0]
        ?.replace(/["`]/g, "");

      const columns = columnsByTable[name] ?? [];

      // Otherwise, check for an INTEGER PRIMARY KEY
      // https://www.sqlite.org/autoinc.html
      if (!autoIncrementCol) {
        const pkCols = columns.filter((r) => r.pk > 0);
        if (pkCols.length === 1 && pkCols[0].type.toLowerCase() === "integer") {
          autoIncrementCol = pkCols[0].name;
        }
      }

      return [
        name,
        {
          name: name,
          isView: type === "view",
          columns: columns.map((col) => ({
            name: col.name,
            dataType: col.type,
            isNullable: !col.notnull,
            isAutoIncrementing: col.name === autoIncrementCol,
            hasDefaultValue: col.dflt_value != null,
            comment: undefined,
          })),
        },
      ];
    })
  );
}

