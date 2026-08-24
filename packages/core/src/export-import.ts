import type { MigratableEvent, SyncDbMigrator } from "./migrations/migrator";
import type { CrdtTableConfig } from "./sqlite-crdt/crdt-schema";
import type { OwnCrdtEvent } from "./sqlite-crdt/crdt-storage";
import type { ExecuteResult } from "./sqlite-db-wrapper";
import { quoteId } from "./utils";

/**
 * A portable, schema-version-aware dump of every active entity in a synced DB.
 * Unlike a raw SQLite snapshot, it carries no event history — just the current
 * `tombstone = 0` rows, ready to be replayed as fresh create events on import.
 */
export type SyncedDbExport = {
  schemaVersion: number;
  exportedAt: string;
  /** base table name -> active rows (each includes `id`, excludes `tombstone`). */
  tables: Record<string, Array<Record<string, unknown>>>;
};

export type ImportDataOptions = { validate?: boolean };
export type ImportDataResult = { imported: number };

type ExportImportReactiveDb = {
  db: { execute<T>(sql: string, meta: { loggerLevel: "system" }): ExecuteResult<T> };
};

type ApplyImportEvents = (events: OwnCrdtEvent[]) => void | Promise<void>;

type ImportMigrator = Pick<SyncDbMigrator, "currentSchemaVersion" | "migrateEvents">;

type CreateExportDataOptions = {
  reactiveDb: ExportImportReactiveDb;
  tablesConfig: CrdtTableConfig[];
  schemaVersion: number;
};

type CreateImportDataOptions = {
  migrator: ImportMigrator;
  tablesConfig?: CrdtTableConfig[];
  applyEvents: ApplyImportEvents;
};

function createTableNameNormalizer(tablesConfig: CrdtTableConfig[] | undefined) {
  const tablesByAlias = new Map<string, CrdtTableConfig>();
  for (const table of tablesConfig ?? []) {
    const { baseTableName, crdtTableName } = table;
    tablesByAlias.set(baseTableName, table);
    tablesByAlias.set(crdtTableName, table);
  }
  return (tableName: string) => {
    const table = tablesByAlias.get(tableName);
    if (table?.exportImport === "ignore") {
      return null;
    }
    return table?.baseTableName ?? tableName;
  };
}

export function createImportData({ migrator, tablesConfig, applyEvents }: CreateImportDataOptions) {
  const normalizeTableName = createTableNameNormalizer(tablesConfig);

  /**
   * Replay an export as a sequence of `item-created` CRDT events, seeding the
   * rows through the provided CRDT event applicator.
   *
   * Schema migration: a dump exported at an older schema version is forward-
   * migrated up to the DB's current version (running the same event transformers
   * remote events go through) before being authored — so an old backup can be
   * restored into an upgraded app. Rows in tables removed by a later migration
   * are dropped. The reverse (a dump from a *newer* version than this DB) cannot
   * be down-migrated and is rejected.
   *
   * Overwrite-by-default: because the generated events carry fresh (newest) HLC
   * timestamps, importing a row whose `id` already exists overwrites every field
   * under last-write-wins, while new ids are inserted. Existing rows absent from
   * the dump are never touched. This is a restore/seed, not a CRDT merge —
   * original timestamps are not preserved.
   *
   * @param opts.validate When `false`, skip the too-new guard and author the rows
   *   as-is at the current version (footgun — payloads are not down-migrated).
   *   Forward migration and per-row payload validation always run regardless.
   */
  return (data: SyncedDbExport, opts?: ImportDataOptions): ImportDataResult | Promise<ImportDataResult> => {
    const validate = opts?.validate ?? true;
    const currentVersion = migrator.currentSchemaVersion;

    if (validate && data.schemaVersion > currentVersion) {
      throw new Error(
        `Cannot import data from schema version ${data.schemaVersion} into a database at older schema version ${currentVersion}. Exports migrate forward to newer schema versions, not backward.`,
      );
    }

    const sourceEvents: MigratableEvent[] = [];
    for (const [tableName, rows] of Object.entries(data.tables)) {
      const normalizedTableName = normalizeTableName(tableName);
      if (normalizedTableName === null) {
        continue;
      }
      for (const row of rows) {
        sourceEvents.push({
          schema_version: data.schemaVersion,
          type: "item-created",
          dataset: normalizedTableName,
          item_id: row.id as string,
          payload: JSON.stringify(row),
        });
      }
    }

    // Forward-migrate the historical export up to the current schema version
    // before authoring it: own events are always written at the current version.
    const events: OwnCrdtEvent[] = migrator.migrateEvents(sourceEvents, currentVersion).map((event) => ({
      type: event.type,
      dataset: event.dataset,
      item_id: event.item_id,
      payload: event.payload,
    }));

    const applied = applyEvents(events);
    if (applied instanceof Promise) {
      return applied.then(() => ({ imported: events.length }));
    }

    return { imported: events.length };
  };
}

export function createExportData({ reactiveDb, tablesConfig, schemaVersion }: CreateExportDataOptions) {
  const tableNames = tablesConfig.flatMap((config) => [config.crdtTableName, config.baseTableName]);

  const resolveTables = (requested: string[] | undefined): CrdtTableConfig[] => {
    if (!requested) {
      return tablesConfig;
    }

    const seenBaseTableNames = new Set<string>();
    const resolved: CrdtTableConfig[] = [];
    for (const name of requested) {
      const config = tablesConfig.find(
        (tableConfig) => tableConfig.crdtTableName === name || tableConfig.baseTableName === name,
      );
      if (!config) {
        throw new Error(`Unknown table "${name}". Known synced tables: ${tableNames.join(", ")}`);
      }
      if (!seenBaseTableNames.has(config.baseTableName)) {
        seenBaseTableNames.add(config.baseTableName);
        resolved.push(config);
      }
    }
    return resolved;
  };

  /**
   * Dump every active entity (the `tombstone = 0` rows) from the synced tables.
   *
   * Reads this tab's reactive (in-memory) DB — the state the user currently sees,
   * which may differ slightly from the worker's authoritative DB while local
   * writes are in flight.
   */
  return (opts?: { tables?: string[] }): SyncedDbExport => {
    const tables: Record<string, Array<Record<string, unknown>>> = {};

    for (const { baseTableName, crdtTableName, exportImport } of resolveTables(opts?.tables)) {
      if (exportImport === "ignore") {
        continue;
      }
      const { rows } = reactiveDb.db.execute<Record<string, unknown>>(`select * from ${quoteId(crdtTableName)}`, {
        loggerLevel: "system",
      });
      tables[baseTableName] = rows.map(({ tombstone: _tombstone, ...rest }) => rest);
    }

    return {
      schemaVersion,
      exportedAt: new Date().toISOString(),
      tables,
    };
  };
}
