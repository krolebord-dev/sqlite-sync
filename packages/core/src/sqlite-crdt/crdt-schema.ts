import type { ColumnType } from "kysely";
import type { Migrations } from "../migrations/migrator";

export type CrdtTableConfig = {
  baseTableName: string;
  crdtTableName: string;
};

export function createSyncDbSchema({ migrations }: { migrations: Migrations }) {
  return new CrdtSchemaBuilder({ tables: [], migrations });
}

export interface CreateCrdtSchemaOptions {
  tables: CrdtTableConfig[];
  migrations: Migrations;
}

// biome-ignore lint/complexity/noBannedTypes: required generic
class CrdtSchemaBuilder<DB = {}> implements SyncDbSchema<DB> {
  constructor(private config: CreateCrdtSchemaOptions) {}

  get tablesConfig() {
    return this.config.tables;
  }

  get migrations() {
    return this.config.migrations;
  }

  get "~schema"() {
    return null as any;
  }

  addTable<Table extends Record<string, unknown>>() {
    const withConfig = <const CrdtTable extends string, const BaseTable extends string>({
      baseTableName,
      crdtTableName,
    }: {
      baseTableName: BaseTable;
      crdtTableName: CrdtTable;
    }) => {
      this.config.tables.push({ baseTableName, crdtTableName });
      return new CrdtSchemaBuilder<DB & { [K in CrdtTable]: Table } & { [K in BaseTable]: ReadonlyTable<Table> }>(
        this.config,
      );
    };

    return { withConfig };
  }

  build() {
    return this as SyncDbSchema<DB>;
  }
}

// biome-ignore lint/complexity/noBannedTypes: required generic
export interface SyncDbSchema<DB = {}> {
  get tablesConfig(): CrdtTableConfig[];
  get migrations(): Migrations;
  "~schema": DB;
}

export type InferCrdtSchema<Schema extends SyncDbSchema> = Prettify<Schema["~schema"]>;

type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type ReadonlyTable<Table extends Record<string, unknown>> = {
  [K in keyof Table]: ColumnType<Table[K], never, never>;
};
