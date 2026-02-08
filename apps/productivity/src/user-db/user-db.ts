import { createSyncedDb } from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import { syncDbSchema, type UserDbProps } from "./migrations";

export const { useDb, DbProvider, useDbQuery, useDbState } = createDbContext(syncDbSchema);

export async function initUserDb({ userId }: { userId: string }) {
  const worker = new Worker(new URL("./user-worker.ts", import.meta.url), {
    type: "module",
  });
  const db = await createSyncedDb({
    dbId: `user-${userId}`,
    worker,
    syncDbSchema,
    workerProps: { userId } as UserDbProps,
  });

  return db;
}
