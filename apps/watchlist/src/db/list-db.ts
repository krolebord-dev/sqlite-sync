import {
  createSyncedDb,
  startPerformanceLogger,
  type SyncedDb,
} from "@sqlite-sync/core";
import { createDbContext } from "@sqlite-sync/react";
import type { ListDatabase } from "./schema";

// Create the React context for database access
export const { useDb, DbProvider, useDbQuery } =
  createDbContext<ListDatabase>();

// Cache for database instances per list
const dbCache = new Map<string, Promise<SyncedDb<ListDatabase>>>();

export type ListDbInstance = SyncedDb<ListDatabase>;

/**
 * Initialize or get the database for a specific list
 * Each list has its own SQLite database file for isolation
 */
export async function initListDb(
  listId: string,
  sessionId: string
): Promise<ListDbInstance> {
  const cacheKey = listId;

  // Return cached instance if available
  const cached = dbCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Create new database instance
  const dbPromise = createListDb(listId, sessionId);
  dbCache.set(cacheKey, dbPromise);

  try {
    return await dbPromise;
  } catch (error) {
    // Remove from cache on error so it can be retried
    dbCache.delete(cacheKey);
    throw error;
  }
}

async function createListDb(
  listId: string,
  sessionId: string
): Promise<ListDbInstance> {
  const perf = startPerformanceLogger(console.log);

  // Create worker with list-specific parameters
  const workerUrl = new URL("./db-worker.ts", import.meta.url);
  workerUrl.searchParams.set("listId", listId);
  workerUrl.searchParams.set("sessionId", sessionId);

  const worker = new Worker(workerUrl, {
    type: "module",
  });

  const db = await createSyncedDb<ListDatabase>({
    dbPath: `/list-${listId}.sqlite3`,
    worker,
    crdtTables: [
      { baseTableName: "_list_items", crdtTableName: "list_items" },
      { baseTableName: "_list_tags", crdtTableName: "list_tags" },
      {
        baseTableName: "_list_tags_to_items",
        crdtTableName: "list_tags_to_items",
      },
    ],
    clearOnInit: true,
  });

  perf.logEnd("initListDb", `success for list ${listId}`);

  return db;
}

/**
 * Close and remove a database instance from cache
 */
export function closeListDb(listId: string): void {
  dbCache.delete(listId);
  // Note: The actual cleanup of the worker happens when it's garbage collected
  // TODO Worker cleanup
}
