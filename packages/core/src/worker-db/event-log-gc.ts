import type { Logger } from "../logger";
import type { SystemDbConfig } from "../migrations/system-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { InternalSQLiteWrapper } from "../sqlite-db-wrapper";

export const WORKER_EVENT_LOG_GC_MIN_RETAINED_EVENTS = 100;

type EventLogGcOptions = {
  db: InternalSQLiteWrapper<any>;
  dbConfig: SystemDbConfig;
  pushSyncId: StoredValue<number>;
  logger?: Logger;
};

export function runWorkerEventLogGc({ db, dbConfig, pushSyncId, logger }: EventLogGcOptions) {
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
    return;
  }

  db.executePreparedRaw<[number, number], never>({
    key: "event-log-gc-delete-events",
    sql: `
      DELETE FROM ${eventsTable}
      WHERE "sync_id" < ?
        AND "status" IN ('applied', 'deduped')
        AND ("origin" = 'remote' OR "sync_id" <= ?)
    `,
    params: [deleteBeforeSyncId, pushSyncId.current],
    meta: { loggerLevel: "system" },
  });

  logger?.("worker", "Event log GC completed", "info");
}
