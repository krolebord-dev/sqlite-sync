import {
  createMigrator as createBaseMigrator,
  createStoredValue,
  type Migrations,
  type StoredValue,
} from "@sqlite-sync/core";
import type { AdapterMode } from "./durable-object-adapter";
import type { KyselyExecutor } from "./kysely-executor";

export function createMigrator(
  mode: AdapterMode,
  kv: SyncKvStorage,
  sqlExecutor: KyselyExecutor<any>,
  migrations: Migrations,
) {
  const schemaVersion = createStoredValue<number>({
    initialValue: kv.get("schema-version") ?? -1,
    saveToStorage: (val) => kv.put("schema-version", val),
  });

  const readonlySchemaVersion: StoredValue<number> = {
    get current() {
      return baseMigrator.latestSchemaVersion;
    },
    set current(_: number) {
      throw new Error("Cannot set schema version in event-log mode");
    },
  };

  const baseMigrator = createBaseMigrator({
    migrations,
    schemaVersion: mode === "materialized" ? schemaVersion : readonlySchemaVersion,
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
