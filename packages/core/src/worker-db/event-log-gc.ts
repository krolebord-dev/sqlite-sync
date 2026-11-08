import type { Logger } from "../logger";
import type { SystemDbConfig } from "../migrations/system-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { InternalSQLiteWrapper } from "../sqlite-db-wrapper";

export const WORKER_EVENT_LOG_GC_MIN_RETAINED_EVENTS = 100;
/** Rows deleted per statement, so each write transaction stays small. */
export const EVENT_LOG_GC_CHUNK_SIZE = 1000;
/** Rows deleted per startup at most; the rest is left for later startups. */
export const EVENT_LOG_GC_MAX_DELETED_EVENTS = 5000;

type EventLogGcOptions = {
  db: InternalSQLiteWrapper<any>;
  dbConfig: SystemDbConfig;
  pushSyncId: StoredValue<number>;
  logger?: Logger;
};

/**
 * Deletes old applied/deduped events from the client event log. Runs on the startup path, so
 * the work per run is bounded and a failure is logged instead of failing startup.
 * Returns the number of deleted events.
 */
export function runWorkerEventLogGc({ db, dbConfig, pushSyncId, logger }: EventLogGcOptions): number {
  try {
    const deleted = deleteOldEvents({ db, dbConfig, pushSyncId });
    logger?.("worker", `Event log GC deleted ${deleted} events`, "info");
    return deleted;
  } catch (error) {
    const message = `Event log GC failed: ${error instanceof Error ? error.message : String(error)}`;
    if (logger) {
      logger("worker", message, "warning");
    } else {
      console.warn(message);
    }
    return 0;
  }
}

function deleteOldEvents({ db, dbConfig, pushSyncId }: Omit<EventLogGcOptions, "logger">): number {
  const eventsTable = dbConfig.eventsTable.fullIdentifier;

  const [{ deleteBeforeSyncId }] = db.executePreparedRaw<[number], { deleteBeforeSyncId: number | null }>({
    key: "event-log-gc-delete-before-sync-id",
    sql: `
      SELECT min("sync_id") AS deleteBeforeSyncId
      FROM (
        SELECT "sync_id"
        FROM ${eventsTable}
        WHERE "status" IN ('applied', 'deduped')
        ORDER BY "sync_id" DESC
        LIMIT ?
      )
    `,
    params: [WORKER_EVENT_LOG_GC_MIN_RETAINED_EVENTS],
    meta: { loggerLevel: "system" },
  });

  if (deleteBeforeSyncId === null) {
    return 0;
  }

  let deleted = 0;
  while (deleted < EVENT_LOG_GC_MAX_DELETED_EVENTS) {
    const limit = Math.min(EVENT_LOG_GC_CHUNK_SIZE, EVENT_LOG_GC_MAX_DELETED_EVENTS - deleted);
    db.executePreparedRaw<[number, number, number], never>({
      key: "event-log-gc-delete-events",
      sql: `
        DELETE FROM ${eventsTable}
        WHERE "sync_id" IN (
          SELECT "sync_id"
          FROM ${eventsTable}
          WHERE "sync_id" < ?
            AND "status" IN ('applied', 'deduped')
            AND ("origin" = 'remote' OR "sync_id" <= ?)
          ORDER BY "sync_id" ASC
          LIMIT ?
        )
      `,
      params: [deleteBeforeSyncId, pushSyncId.current, limit],
      meta: { loggerLevel: "system" },
    });
    const [{ changes }] = db.executePreparedRaw<[], { changes: number }>({
      key: "event-log-gc-changes",
      sql: `SELECT changes() AS "changes"`,
      meta: { loggerLevel: "system" },
    });
    deleted += changes;
    if (changes < limit) {
      break;
    }
  }

  return deleted;
}
