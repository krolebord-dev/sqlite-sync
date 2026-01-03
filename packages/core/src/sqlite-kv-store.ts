import type { SchemaModule } from "kysely";
import { createStoredValue } from "./sqlite-crdt/stored-value";
import type { SQLiteTransactionWrapper } from "./sqlite-db-wrapper";

export type KvStoreItem = {
  key: string;
  value: string;
};

export function createKvStoreTableQuery(schema: SchemaModule, tableName: string) {
  return schema
    .createTable(tableName)
    .ifNotExists()
    .addColumn("key", "text", (col) => col.notNull().primaryKey())
    .addColumn("value", "text", (col) => col.notNull());
}

export function createSQLiteKvStore({
  db,
  metaTableName,
}: {
  db: SQLiteTransactionWrapper<any>;
  metaTableName: string;
}) {
  const metaDb = db as SQLiteTransactionWrapper<{
    meta: KvStoreItem;
  }>;

  const get = (key: string): string | null => {
    const [result] = metaDb.executePrepared("get-meta-value", { key }, (db, params) =>
      db
        .selectFrom(metaTableName as "meta")
        .where("key", "=", params("key"))
        .select("value")
        .limit(1),
    );

    return result?.value ?? null;
  };

  const set = (key: string, value: string) => {
    metaDb.executePrepared("set-meta-value", { key, value }, (db, params) =>
      db
        .insertInto(metaTableName as "meta")
        .values({ key: params("key"), value: params("value") })
        .onConflict((oc) => oc.doUpdateSet({ value: params("value") })),
    );
  };

  const remove = (key: string) => {
    metaDb.executePrepared("remove-meta-value", { key }, (db, params) =>
      db.deleteFrom(metaTableName as "meta").where("key", "=", params("key")),
    );
  };

  const getNumberOrDefault = <T>(key: string, defaultValue: T): T | number => {
    const value = get(key);
    if (!value) return defaultValue;
    const parsedValue = Number.parseInt(value, 10);
    return Number.isNaN(parsedValue) ? defaultValue : parsedValue;
  };

  return {
    get,
    set,
    remove,
    createStringStoredValue: (key: string, defaultValue: string) =>
      createStoredValue<string>({
        initialValue: get(key) ?? defaultValue,
        saveToStorage: (val) => set(key, val),
      }),
    createNumberStoredValue: (key: string, defaultValue: number) =>
      createStoredValue<number>({
        initialValue: getNumberOrDefault(key, defaultValue),
        saveToStorage: (val) => set(key, val.toString()),
      }),
  };
}
