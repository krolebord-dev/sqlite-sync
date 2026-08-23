import type { AiAccess, SyncDbSchema } from "@sqlite-sync/core";

export type ResolvedTablePolicy = {
  crdtTableName: string;
  baseTableName: string;
  access: AiAccess;
};

export type ResolvedAiPolicy = {
  /** In schema declaration order, hidden tables included. */
  tables: ResolvedTablePolicy[];
  hasHiddenTables: boolean;
  /** Base table names the agent may read. Only meaningful when `hasHiddenTables` is true. */
  readableBaseTableNames: string[];
  /** Resolves either the crdt or the base table name; anything unknown is "hidden". */
  tableAccess(dataset: string): AiAccess;
};

/**
 * Flattens the AI access declared on the schema's table builders into the lookups the doc
 * generator and the enforcement points share, so they cannot disagree. Access is table-level:
 * see {@link AiAccess}.
 */
export function resolveAiPolicy(opts: { syncDbSchema: SyncDbSchema }): ResolvedAiPolicy {
  const tables: ResolvedTablePolicy[] = opts.syncDbSchema.tablesConfig.map(({ crdtTableName, baseTableName }) => ({
    crdtTableName,
    baseTableName,
    access: opts.syncDbSchema.tables[crdtTableName].aiAccess,
  }));

  // CRDT events address a table by either name, so both resolve to the same policy.
  const byName = new Map<string, ResolvedTablePolicy>();
  for (const table of tables) {
    byName.set(table.crdtTableName, table);
    byName.set(table.baseTableName, table);
  }

  return {
    tables,
    hasHiddenTables: tables.some((table) => table.access === "hidden"),
    readableBaseTableNames: tables.filter((table) => table.access !== "hidden").map((table) => table.baseTableName),
    tableAccess(dataset) {
      return byName.get(dataset)?.access ?? "hidden";
    },
  };
}
