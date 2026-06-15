import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { introspectDb, type TableMetadata } from "../introspection";
import { createMigrator } from "../migrations/migrator";
import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import { createStoredValue } from "../sqlite-crdt/stored-value";
import { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import type { ColumnKind, ColumnMeta } from "./table-builder";

export type SchemaVerificationIssue = {
  table: string;
  column?: string;
  message: string;
};

const acceptedDataTypes: Record<ColumnKind, string[]> = {
  text: ["TEXT"],
  integer: ["INTEGER", "INT"],
  real: ["REAL", "DOUBLE", "FLOAT"],
  boolean: ["BOOLEAN", "INTEGER", "INT"],
  enum: ["TEXT"],
};

let sqliteModule: Sqlite3Static | null = null;

/**
 * Verify that replaying the full migration history on a fresh database produces
 * exactly the declared table schema. Creates a throwaway in-memory SQLite db,
 * applies all migrations, introspects the result, and diffs it against the
 * `t.table()` declarations.
 *
 * Returns an empty array when migrations and schema agree. Intended for dev-time
 * checks (`startDbWorker({ verifySchema: true })`) and tests:
 * `expect(await verifySyncSchema(syncDbSchema)).toEqual([])`.
 */
export async function verifySyncSchema(schema: SyncDbSchema): Promise<SchemaVerificationIssue[]> {
  if (!sqliteModule) {
    sqliteModule = await sqlite3InitModule();
  }
  const sqlite3 = sqliteModule;

  const db = new SQLiteDbWrapper({
    db: () => new sqlite3.oo1.DB({ filename: ":memory:" }),
    logger: () => {},
    loggerPrefix: "schema-verify",
    sqlite3,
  });

  try {
    const migrator = createMigrator({
      migrations: schema.migrations,
      schemaVersion: createStoredValue({ initialValue: -1 }),
    });

    try {
      migrator.migrateDbToLatest({
        startTransaction: (callback) => {
          db.executeTransaction((tx) =>
            callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
          );
        },
      });
    } catch (error) {
      return [
        {
          table: "(migrations)",
          message: `migration replay failed on an empty database: ${error instanceof Error ? error.message : String(error)}`,
        },
      ];
    }

    const introspection = introspectDb(db);

    const issues: SchemaVerificationIssue[] = [];
    for (const { crdtTableName, baseTableName } of schema.tablesConfig) {
      const declared = schema.tables[crdtTableName];
      if (!declared) continue;
      verifyTable(db, baseTableName, declared.columns, introspection[baseTableName], issues);
    }
    return issues;
  } finally {
    db.close();
  }
}

export function formatSchemaVerificationIssues(issues: SchemaVerificationIssue[]): string {
  const lines = issues.map(
    (issue) => ` - table "${issue.table}"${issue.column ? ` column "${issue.column}"` : ""}: ${issue.message}`,
  );
  return `sync schema verification failed (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}`;
}

function verifyTable(
  db: SQLiteDbWrapper,
  table: string,
  declaredColumns: Record<string, ColumnMeta>,
  actual: TableMetadata | undefined,
  issues: SchemaVerificationIssue[],
) {
  if (!actual) {
    issues.push({
      table,
      message: "declared in the schema but missing after migrations — add a createTable step in a new version",
    });
    return;
  }
  if (actual.isView) {
    issues.push({ table, message: "expected a base table, but migrations created a view with this name" });
    return;
  }

  const actualColumns = new Map(actual.columns.map((column) => [column.name, column]));

  for (const [name, meta] of Object.entries(declaredColumns)) {
    const column = actualColumns.get(name);
    if (!column) {
      issues.push({
        table,
        column: name,
        message: "declared in the schema but missing after migrations — add an addColumn step in a new version",
      });
      continue;
    }

    const accepted = acceptedDataTypes[meta.kind];
    if (!accepted.includes(column.dataType.toUpperCase())) {
      issues.push({
        table,
        column: name,
        message: `type mismatch — schema declares ${meta.kind} (${accepted.join("/")}), migrated column is ${column.dataType.toUpperCase()}`,
      });
    }

    if (column.isNullable !== meta.nullable) {
      issues.push({
        table,
        column: name,
        message: meta.nullable
          ? "schema declares the column nullable, but the migrated column is NOT NULL"
          : "schema declares the column NOT NULL, but the migrated column is nullable",
      });
    }

    if (name === "id" && !column.isPrimaryKey) {
      issues.push({ table, column: name, message: "the id column must be the PRIMARY KEY" });
    }

    verifyDefault(db, table, name, meta, column.defaultValueSql, issues);
  }

  for (const column of actual.columns) {
    if (!(column.name in declaredColumns)) {
      issues.push({
        table,
        column: column.name,
        message:
          "created by migrations but not declared in the schema — sync event payloads include every column, so declare it (or drop it in a new version)",
      });
    }
  }
}

function verifyDefault(
  db: SQLiteDbWrapper,
  table: string,
  column: string,
  meta: ColumnMeta,
  defaultValueSql: string | null,
  issues: SchemaVerificationIssue[],
) {
  // A declared `null` default and an absent DEFAULT clause are equivalent in SQLite
  // (a column with no DEFAULT defaults to NULL), so don't flag that pairing.
  if (meta.hasDefault && meta.defaultValue !== null && defaultValueSql === null) {
    issues.push({
      table,
      column,
      message: `schema declares default ${formatExpected(meta)}, but the migrated column has no default`,
    });
    return;
  }
  if (!meta.hasDefault && defaultValueSql !== null) {
    issues.push({
      table,
      column,
      message: `migrated column has default ${defaultValueSql}, but the schema declares none`,
    });
    return;
  }
  if (!meta.hasDefault || defaultValueSql === null) {
    return;
  }

  // Declared defaults are always constants (ColumnBuilder.default takes a JS value),
  // so a non-constant migrated default (e.g. strftime(...)) is always a real mismatch.
  let actual: unknown;
  try {
    actual = db.execute<{ value: unknown }>({
      sql: `SELECT (${defaultValueSql}) AS value`,
      parameters: [],
    }).rows[0]?.value;
  } catch {
    actual = undefined;
  }

  if (actual !== expectedDefaultValue(meta)) {
    issues.push({
      table,
      column,
      message: `default mismatch — schema declares ${formatExpected(meta)}, migrated column default is ${defaultValueSql}`,
    });
  }
}

/** The declared default normalized to how SQLite stores it (booleans as 0/1). */
function expectedDefaultValue(meta: ColumnMeta): string | number | null {
  if (meta.defaultValue === null) return null;
  switch (meta.kind) {
    case "boolean":
      return meta.defaultValue ? 1 : 0;
    case "integer":
    case "real":
      return Number(meta.defaultValue);
    case "text":
    case "enum":
      return String(meta.defaultValue);
  }
}

function formatExpected(meta: ColumnMeta): string {
  const expected = expectedDefaultValue(meta);
  return typeof expected === "string" ? `'${expected}'` : String(expected);
}
