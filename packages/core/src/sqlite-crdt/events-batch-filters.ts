import type { SelectQueryBuilder } from "kysely";
import type { GetEventsOptions } from "./crdt-storage";
import type { PersistedCrdtEvent } from "./crdt-table-schema";

export function applyKyselyEventsBatchFilters(
  query: SelectQueryBuilder<any, any, PersistedCrdtEvent>,
  opts: GetEventsOptions,
) {
  if (opts.afterSyncId) {
    query = query.where("sync_id", ">", opts.afterSyncId);
  }
  if (opts.status) {
    query = query.where("status", "=", opts.status);
  }
  if (opts.excludeOrigin) {
    query = query.where("origin", "!=", opts.excludeOrigin);
  }

  return query.limit(opts.limit ?? 50).orderBy("sync_id", "asc");
}
