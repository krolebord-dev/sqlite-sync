import { createSyncedDb, startPerformanceLogger } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import { logger } from "./logger";
import type { Database } from "./seed";

export const { useDb, DbProvider, useDbQuery } = createDbContext<{
  _todo: {
    id: string;
    title: string;
    completed: boolean;
    tombstone: boolean;
  };
  todo: {
    id: string;
    title: string;
    completed: boolean;
    tombstone: boolean;
  };
}>();

export async function initDb() {
  const perf = startPerformanceLogger(logger);
  const worker = new Worker(new URL("./db-worker.ts", import.meta.url), {
    type: "module",
  });
  const db = await createSyncedDb<Database>({
    dbPath: "/db.sqlite3",
    worker,
    crdtTables: [{ baseTableName: "_todo", crdtTableName: "todo" }],
    clearOnInit: window.location.search.includes("clear"),
  });

  perf.logEnd("initDb", "success");

  return db;
}
