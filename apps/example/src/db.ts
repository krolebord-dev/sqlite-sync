import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import type { Database } from "./seed";

export const { useDb, DbProvider, useDbQuery, useDbState } = createDbContext<{
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
  };
}>();

export async function initDb() {
  const worker = new Worker(new URL("./db-worker.ts", import.meta.url), {
    type: "module",
  });
  const db = await createSyncedDb<Database>({
    dbId: "example-db",
    worker,
    crdtTables: [{ baseTableName: "_todo", crdtTableName: "todo" }],
    clearOnInit: window.location.search.includes("clear"),
    workerProps: undefined,
  });

  return db;
}
