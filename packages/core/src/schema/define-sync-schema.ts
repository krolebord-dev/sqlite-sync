import type { Migrations } from "../migrations/migrator";
import type { CrdtTableConfig, ReadonlyTable, SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import { buildWriteOriginByName } from "./admit-client-events";
import type {
  AnyTableBuilder,
  InferRow,
  SyncSchemaTables,
  TableBuilder,
  TableColumns,
  WriteOrigin,
} from "./table-builder";

type Simplify<T> = { [K in keyof T]: T[K] } & {};

// Names sqlite-sync uses for its own tables/views, so a user schema can't shadow them.
const RESERVED_TABLE_NAMES = new Set<string>([
  "change_history",
  "crdt_events",
  "worker.crdt_events",
  "persisted_crdt_events",
  "crdt_update_log",
  "crdt_change_intents",
  "worker.kv",
]);

type RowOf<Table extends AnyTableBuilder> =
  Table extends TableBuilder<infer Cols extends TableColumns, any, WriteOrigin> ? InferRow<Cols> : never;

// Falls back to the "_" convention unless ~baseName is a string *literal* — inference can
// resolve an omitted override to its constraint (string | undefined) rather than undefined.
type BaseNameOf<CrdtName, Table extends AnyTableBuilder> = string extends Table["~baseName"]
  ? `_${CrdtName & string}`
  : [Table["~baseName"]] extends [string]
    ? Table["~baseName"]
    : `_${CrdtName & string}`;

type ClientSchemaOf<Tables extends SyncSchemaTables> = Simplify<
  {
    [K in keyof Tables]: Tables[K]["~writeOrigin"] extends "server"
      ? ReadonlyTable<RowOf<Tables[K]>>
      : RowOf<Tables[K]>;
  } & {
    [K in keyof Tables as BaseNameOf<K, Tables[K]>]: ReadonlyTable<RowOf<Tables[K]>>;
  }
>;

type ServerSchemaOf<Tables extends SyncSchemaTables> = Simplify<
  { [K in keyof Tables]: RowOf<Tables[K]> } & {
    [K in keyof Tables as BaseNameOf<K, Tables[K]>]: ReadonlyTable<RowOf<Tables[K]>>;
  }
>;

type MutationsSchemaOf<Tables extends SyncSchemaTables> = Simplify<{
  [K in keyof Tables as BaseNameOf<K, Tables[K]>]: RowOf<Tables[K]>;
}>;

export interface DefinedSyncSchema<Tables extends SyncSchemaTables>
  extends SyncDbSchema<ClientSchemaOf<Tables>, ServerSchemaOf<Tables>, MutationsSchemaOf<Tables>> {
  /** The table builders, for type extraction (`typeof schema.tables.item.$row`) and runtime metadata. */
  tables: Tables;
  /** Write origin keyed by crdt and base table name. */
  writeOriginByName: ReadonlyMap<string, WriteOrigin>;
}

export type DefineSyncSchemaConfig<Tables extends SyncSchemaTables> = {
  tables: Tables;
  /** Full migration history (including the initial createTable version), built with `createMigrations`. */
  migrations: Migrations;
};

/**
 * Define a sync database schema from `t.table()` builders.
 *
 * Record keys are the crdt (view) table names; base table names default to the key
 * prefixed with "_", overridable per table via `t.table(cols, { baseName })`.
 */
export function defineSyncSchema<Tables extends SyncSchemaTables>({
  tables,
  migrations,
}: DefineSyncSchemaConfig<Tables>): DefinedSyncSchema<Tables> {
  const tablesConfig: CrdtTableConfig[] = Object.entries(tables).map(([crdtTableName, table]) => ({
    crdtTableName,
    baseTableName: table.baseName ?? `_${crdtTableName}`,
    ...(table.exportImport === "ignore" ? { exportImport: "ignore" } : {}),
  }));

  const seenNames = new Set<string>();
  for (const { crdtTableName, baseTableName } of tablesConfig) {
    for (const name of [crdtTableName, baseTableName]) {
      const normalizedName = name.toLowerCase();
      if (RESERVED_TABLE_NAMES.has(normalizedName)) {
        throw new Error(`Table name "${name}" is reserved by sqlite-sync and cannot be used in a sync schema`);
      }
      if (seenNames.has(normalizedName)) {
        throw new Error(`Duplicate table name "${name}" in sync schema`);
      }
      seenNames.add(normalizedName);
    }
  }

  const writeOriginByName = buildWriteOriginByName({ tables, tablesConfig });

  return {
    tables,
    get tablesConfig() {
      return tablesConfig;
    },
    get writeOriginByName() {
      return writeOriginByName;
    },
    get migrations() {
      return migrations;
    },
    get "~clientSchema"(): never {
      throw new Error("~clientSchema is type-only and cannot be accessed at runtime");
    },
    get "~serverSchema"(): never {
      throw new Error("~serverSchema is type-only and cannot be accessed at runtime");
    },
    get "~mutationsSchema"(): never {
      throw new Error("~mutationsSchema is type-only and cannot be accessed at runtime");
    },
  };
}
