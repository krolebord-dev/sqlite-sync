import { createMigrator as createBaseMigrator, createStoredValue, type Migrations } from "@sqlite-sync/core";

export function createMigrator(storage: DurableObjectStorage, migrations: Migrations) {
  const schemaVersion = createStoredValue<number>({
    initialValue: storage.kv.get("schema-version") ?? -1,
    saveToStorage: (val) => storage.kv.put("schema-version", val),
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
          storage.transactionSync(() => {
            return callback({ execute: (sql, parameters) => storage.sql.exec(sql, ...parameters) });
          });
        },
      });
    },
  };
}

export type SyncDbMigrator = ReturnType<typeof createMigrator>;
