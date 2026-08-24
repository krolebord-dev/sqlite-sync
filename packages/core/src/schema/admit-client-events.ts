import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import type { WriteOrigin } from "./table-builder";

export type AdmitClientEventsResult<T> = {
  admitted: T[];
  skipped: T[];
};

type SchemaForAdmitClientEvents = Pick<SyncDbSchema, "tables" | "tablesConfig"> & {
  writeOriginByName?: ReadonlyMap<string, WriteOrigin>;
};

export function buildWriteOriginByName(
  schema: Pick<SyncDbSchema, "tables" | "tablesConfig">,
): Map<string, WriteOrigin> {
  const writeOriginByName = new Map<string, WriteOrigin>();
  for (const { crdtTableName, baseTableName } of schema.tablesConfig) {
    const writeOrigin = schema.tables[crdtTableName]?.writeOrigin ?? "any";
    writeOriginByName.set(crdtTableName, writeOrigin);
    writeOriginByName.set(baseTableName, writeOrigin);
  }
  return writeOriginByName;
}

/**
 * Splits a client push into events the hub should persist and events for tables with
 * `{ writes: "server" }`. Unknown datasets stay admitted. Matches either the crdt or the base
 * table name.
 */
export function admitClientEvents<T extends { dataset: string }>(opts: {
  syncDbSchema: SchemaForAdmitClientEvents;
  events: readonly T[];
}): AdmitClientEventsResult<T> {
  const writeOriginByName = opts.syncDbSchema.writeOriginByName ?? buildWriteOriginByName(opts.syncDbSchema);

  const admitted: T[] = [];
  const skipped: T[] = [];
  for (const event of opts.events) {
    if (writeOriginByName.get(event.dataset) === "server") {
      skipped.push(event);
    } else {
      admitted.push(event);
    }
  }
  return { admitted, skipped };
}
