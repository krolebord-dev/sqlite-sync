import { createMigrator as createBaseMigrator, createStoredValue, type Migrations } from "@sqlite-sync/core";

export type SqlStatementExecutor = {
  execute<TResult = unknown>(query: { sql: string; parameters: readonly unknown[] }): { rows: TResult[] };
};

export type TransactionalSqlExecutor = SqlStatementExecutor & {
  transaction(callback: (tx: SqlStatementExecutor) => void): void;
};

export function createMigrator(
  kv: SyncKvStorage,
  sqlExecutor: TransactionalSqlExecutor,
  migrations: Migrations,
  updateLogTableName?: string,
) {
  const schemaVersion = createStoredValue<number>({
    initialValue: kv.get("schema-version") ?? -1,
    saveToStorage: (val) => kv.put("schema-version", val),
  });

  const baseMigrator = createBaseMigrator({
    migrations,
    schemaVersion,
    updateLogTableName,
  });

  return {
    ...baseMigrator,
    migrateDbToLatest: () => {
      baseMigrator.migrateDbToLatest({
        startTransaction: (callback) => {
          sqlExecutor.transaction((tx) => {
            return callback({
              execute: (sql, parameters) =>
                tx.execute({
                  sql,
                  parameters,
                }),
            });
          });
        },
      });
    },
  };
}

export type SyncDbMigrator = ReturnType<typeof createMigrator>;
