import { createMigrator as createBaseMigrator, createStoredValue, type Migrations } from "@sqlite-sync/core";
import type { KyselyExecutor } from "./kysely-executor";

export function createMigrator(kv: SyncKvStorage, sqlExecutor: KyselyExecutor<any>, migrations: Migrations) {
  const schemaVersion = createStoredValue<number>({
    initialValue: kv.get("schema-version") ?? -1,
    saveToStorage: (val) => kv.put("schema-version", val),
  });

  const baseMigrator = createBaseMigrator({
    migrations,
    schemaVersion,
  });

  return {
    ...baseMigrator,
    migrateDbToLatest: () => {
      baseMigrator.migrateDbToLatest({
        startTransaction: (callback) => {
          sqlExecutor.transaction(() => {
            return callback({
              execute: (sql, parameters) =>
                sqlExecutor.execute({
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
