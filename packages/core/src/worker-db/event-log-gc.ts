import type { Logger } from "../logger";
import type { SystemDbConfig } from "../migrations/system-schema";
import type { StoredValue } from "../sqlite-crdt/stored-value";
import type { InternalSQLiteWrapper } from "../sqlite-db-wrapper";

export const WORKER_EVENT_LOG_GC_MIN_RETAINED_EVENTS = 100;

type EventLogGcOptions = {
  db: InternalSQLiteWrapper<any>;
  dbConfig: SystemDbConfig;
  pushSyncId: StoredValue<number>;
  eventHlcAccumulator: StoredValue<string>;
  logger?: Logger;
};

export function runWorkerEventLogGc({ db, dbConfig, pushSyncId, eventHlcAccumulator, logger }: EventLogGcOptions) {
  const eventsTable = dbConfig.eventsTable.fullIdentifier;

  if (eventHlcAccumulator.current === "") {
    const [{ count }] = db.executePreparedRaw<[], { count: number }>({
      key: "event-log-gc-count-applied-events",
      sql: `SELECT count(*) AS count FROM ${eventsTable} WHERE "status" = 'applied'`,
      meta: { loggerLevel: "system" },
    });
    if (count > 0) {
      logger?.(
        "worker",
        "Skipping event log GC until the event HLC checksum has been computed from full history",
        "info",
      );
    }
    return { skipped: true as const };
  }

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
    return { skipped: false as const };
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
  return { skipped: false as const };
}
