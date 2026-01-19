import {
  createMigrator as createBaseMigrator,
  createStoredValue,
  type Migrations,
  type StoredValue,
} from "@sqlite-sync/core";
import type { AdapterMode } from "./durable-object-adapter";

export function createMigrator(mode: AdapterMode, storage: DurableObjectStorage, migrations: Migrations) {
  const schemaVersion = createStoredValue<number>({
    initialValue: storage.kv.get("schema-version") ?? -1,
    saveToStorage: (val) => storage.kv.put("schema-version", val),
  });

  const readonlySchemaVersion: StoredValue<number> = {
    get current() {
      return baseMigrator.latestSchemaVersion;
    },
    set current(_: number) {
      throw new Error("Cannot set schema version in apply-events mode");
    },
  };

  const baseMigrator = createBaseMigrator({
    migrations,
    schemaVersion: mode === "apply-events" ? schemaVersion : readonlySchemaVersion,
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
