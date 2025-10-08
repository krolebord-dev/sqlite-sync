import { createDbContext } from "./lib/react";
import { SyncedDb } from "./lib/sync-db";
import { seedDatabase, type Database } from "./seed";

export const { useDb, DbProvider, useDbQuery } = createDbContext<Database>();

export async function initDb() {
  const db = await SyncedDb.create<Database>({ dbPath: "db.sqlite3" });

  await seedDatabase({
    async sql(queryTemplate, ...params) {
      return db.memoryDb.sql(queryTemplate, ...params).rows;
    },
  });

  console.log("recordChanges");
  db.memoryDb.recordChanges();
  console.log("recordChanges");

  return db;
}
