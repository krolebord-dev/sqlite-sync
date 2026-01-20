import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import { type ListDbProps, syncDbSchema } from "./migrations";

export const { useDb, DbProvider, useDbQuery, useDbState } = createDbContext(syncDbSchema);

export async function initListDb({ listId }: { listId: string }) {
  const worker = new Worker(new URL("./list-worker.ts", import.meta.url), {
    type: "module",
  });
  const db = await createSyncedDb({
    dbId: `list-${listId}`,
    worker,
    syncDbSchema,
    workerProps: { listId } as ListDbProps,
  });

  return db;
}
