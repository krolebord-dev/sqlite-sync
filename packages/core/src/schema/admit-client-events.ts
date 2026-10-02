import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import type { WriteOrigin } from "./table-builder";

export type AdmitClientEventsResult<T> = {
  admitted: T[];
  skipped: T[];
};

type SchemaForAdmitClientEvents = Pick<SyncDbSchema, "tables" | "tablesConfig">;

export type ClientDatasetRejectionReason = "server-only-dataset" | "undeclared-dataset";

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
 * datasets that exactly match the base table name of a declared table without
 * `{ writes: "server" }` are admitted; server-only tables, crdt view names, and undeclared
 * datasets are skipped.
 */
export function admitClientEvents<T extends { dataset: string }>(opts: {
  syncDbSchema: SchemaForAdmitClientEvents;
  events: readonly T[];
}): AdmitClientEventsResult<T> {
  const admitted: T[] = [];
  const skipped: T[] = [];
  for (const event of opts.events) {
    if (getClientDatasetRejection(opts.syncDbSchema, event.dataset)) {
      skipped.push(event);
    } else {
      admitted.push(event);
    }
  }
  return { admitted, skipped };
}

export function getClientDatasetRejection(
  schema: SchemaForAdmitClientEvents,
  dataset: string,
): ClientDatasetRejectionReason | null {
  const config = schema.tablesConfig.find((tableConfig) => tableConfig.baseTableName === dataset);
  if (!config) {
    return "undeclared-dataset";
  }
  return schema.tables[config.crdtTableName]?.writeOrigin === "server" ? "server-only-dataset" : null;
}
