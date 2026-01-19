import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import { syncDbSchema } from "./migrations";

export const { useDb, DbProvider, useDbQuery, useDbState } = createDbContext(syncDbSchema);

export async function initDb() {
  const worker = new Worker(new URL("./db-worker.ts", import.meta.url), {
    type: "module",
  });
  const db = await createSyncedDb({
    dbId: "example-db",
    worker,
    syncDbSchema,
    clearOnInit: window.location.search.includes("clear"),
    workerProps: undefined,
  });

  return db;
}
