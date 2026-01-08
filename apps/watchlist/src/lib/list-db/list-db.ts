import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import type { ListDb } from "./migrations";

export const { useDb, DbProvider, useDbQuery, useDbState } = createDbContext<ListDb>();

export async function initListDb({ listId }: { listId: string }) {
  const worker = new Worker(new URL("./list-worker.ts", import.meta.url), {
    type: "module",
  });
  const db = await createSyncedDb<ListDb>({
    dbId: `list-${listId}`,
    worker,
    crdtTables: [{ baseTableName: "_item", crdtTableName: "item" }],
  });

  return db;
}
