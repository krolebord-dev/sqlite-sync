import type { CrdtTableConfig } from "./sqlite-crdt/crdt-schema";
import type { CrdtStorage, OwnCrdtEvent } from "./sqlite-crdt/crdt-storage";
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
  /** crdt table name -> active rows (each includes `id`, excludes `tombstone`). */
  tables: Record<string, Array<Record<string, unknown>>>;
};

export type ImportDataOptions = { validate?: boolean };
export type ImportDataResult = { imported: number };

type ExportImportReactiveDb = {
  db: { execute<T>(sql: string, meta: { loggerLevel: "system" }): ExecuteResult<T> };
};

type ApplyImportEvents = (events: OwnCrdtEvent[]) => void | Promise<void>;

type CreateExportImportOptions = {
  reactiveDb: ExportImportReactiveDb;
  crdtStorage: CrdtStorage;
  tablesConfig: CrdtTableConfig[];
  schemaVersion: number;
  importData?: (data: SyncedDbExport, opts?: ImportDataOptions) => ImportDataResult | Promise<ImportDataResult>;
};

type CreateImportDataOptions = {
  schemaVersion: number;
  applyEvents: ApplyImportEvents;
};

export function createImportData({ schemaVersion, applyEvents }: CreateImportDataOptions) {
  /**
   * Replay an export as a sequence of `item-created` CRDT events, seeding the
   * rows through the provided CRDT event applicator.
   *
   * Overwrite-by-default: because the generated events carry fresh (newest) HLC
   * timestamps, importing a row whose `id` already exists overwrites every field
   * under last-write-wins, while new ids are inserted. Existing rows absent from
   * the dump are never touched. This is a restore/seed, not a CRDT merge —
   * original timestamps are not preserved.
   *
   * @param opts.validate When `false`, skip the schema-version match check. Per-row
   *   payload validation always runs (it is intrinsic to applying own events).
   */
  return (data: SyncedDbExport, opts?: ImportDataOptions): ImportDataResult | Promise<ImportDataResult> => {
    const validate = opts?.validate ?? true;

    if (validate && data.schemaVersion !== schemaVersion) {
      throw new Error(
        `Cannot import data from schema version ${data.schemaVersion} into a database at schema version ${schemaVersion}.`,
      );
    }

    const events: OwnCrdtEvent[] = [];
    for (const [crdtTableName, rows] of Object.entries(data.tables)) {
      for (const row of rows) {
        events.push({
          type: "item-created",
          dataset: crdtTableName,
          item_id: row.id as string,
          payload: JSON.stringify(row),
        });
      }
    }

    const applied = applyEvents(events);
    if (applied instanceof Promise) {
      return applied.then(() => ({ imported: events.length }));
    }

    return { imported: events.length };
  };
}

export function createExportImport({
  reactiveDb,
  crdtStorage,
  tablesConfig,
  schemaVersion,
  importData: importDataOverride,
}: CreateExportImportOptions) {
  const crdtTableNames = tablesConfig.map((config) => config.crdtTableName);

  const resolveTables = (requested: string[] | undefined): string[] => {
    if (!requested) {
      return crdtTableNames;
    }
    for (const name of requested) {
      if (!crdtTableNames.includes(name)) {
        throw new Error(`Unknown table "${name}". Known synced tables: ${crdtTableNames.join(", ")}`);
      }
    }
    return requested;
  };

  /**
   * Dump every active entity (the `tombstone = 0` rows) from the synced tables.
   *
   * Reads this tab's reactive (in-memory) DB — the state the user currently sees,
   * which may differ slightly from the worker's authoritative DB while local
   * writes are in flight.
   */
  const exportData = (opts?: { tables?: string[] }): SyncedDbExport => {
    const tables: Record<string, Array<Record<string, unknown>>> = {};

    for (const crdtTableName of resolveTables(opts?.tables)) {
      const { rows } = reactiveDb.db.execute<Record<string, unknown>>(`select * from ${quoteId(crdtTableName)}`, {
        loggerLevel: "system",
      });
      tables[crdtTableName] = rows.map(({ tombstone: _tombstone, ...rest }) => rest);
    }

    return {
      schemaVersion,
      exportedAt: new Date().toISOString(),
      tables,
    };
  };

  const importData =
    importDataOverride ??
    createImportData({
      schemaVersion,
      applyEvents: (events) => crdtStorage.applyOwnEvents(events),
    });

  return { exportData, importData };
}
