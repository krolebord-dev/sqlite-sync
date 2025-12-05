import { startPerformanceLogger } from "./lib/logger";
import { createDbContext } from "./lib/react";
import { makeCrdtTable } from "./lib/sqlite-crdt/make-crdt-table";
import { SyncedDb } from "./lib/sync-db";
import { generateId } from "./lib/utils";
import { logger } from "./logger";
import { type Database } from "./seed";

export const { useDb, DbProvider, useDbQuery } = createDbContext<{
  _todo: {
    id: string;
    title: string;
    completed: boolean;
    tombstone: boolean;
  };
}>();

const clientId = new URLSearchParams(window.location.search).get("clientId");
if (!clientId) {
  throw new Error("clientId is required");
}

export async function initDb() {
  const perf = startPerformanceLogger(logger);
  const db = await SyncedDb.create<Database>({
    dbPath: "db.sqlite3",
    tabId: generateId(),
    clientId: clientId!,
    logger,
  });

  makeCrdtTable({
    db: db.memoryDb.db,
    baseTableName: "_todo",
    crdtTableName: "todo",
  });

  perf.logEnd("initDb", "success");

  return db;
}
