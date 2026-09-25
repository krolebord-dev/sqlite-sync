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
 * Splits a client push into events the hub should persist and events it must drop. Only
 * datasets that exactly match the crdt or base name of a declared table without
 * `{ writes: "server" }` are admitted; server-only and undeclared datasets are skipped.
 */
export function admitClientEvents<T extends { dataset: string }>(opts: {
  syncDbSchema: SchemaForAdmitClientEvents;
  events: readonly T[];
}): AdmitClientEventsResult<T> {
  const writeOriginByName = opts.syncDbSchema.writeOriginByName ?? buildWriteOriginByName(opts.syncDbSchema);

  const admitted: T[] = [];
  const skipped: T[] = [];
  for (const event of opts.events) {
    if (writeOriginByName.get(event.dataset) === "any") {
      admitted.push(event);
    } else {
      skipped.push(event);
    }
  }
  return { admitted, skipped };
}
