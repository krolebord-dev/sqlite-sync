import { startPerformanceLogger } from "./lib/logger";
import { createDbContext } from "./lib/react";
import { SyncedDb } from "./lib/sync-db";
import { generateId } from "./lib/utils";
import { logger } from "./logger";
import { type Database } from "./seed";

export const { useDb, DbProvider, useDbQuery } = createDbContext<{
  todo: {
    id: string;
    title: string;
    completed: boolean;
    tombstone: boolean;
  };
}>();

export async function initDb() {
  const perf = startPerformanceLogger(logger);
  const db = await SyncedDb.create<Database>({
    dbPath: "db.sqlite3",
    nodeId: `tab-${generateId()}`,
    logger,
  });

  db.crdtifyTable("todo");

  perf.logEnd("initDb", "success");

  return db;
}
