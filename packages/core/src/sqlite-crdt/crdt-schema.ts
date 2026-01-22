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
class CrdtSchemaBuilder<ClientDB = {}, ServerDB = {}, MutationsDB = {}>
  implements SyncDbSchema<ClientDB, ServerDB, MutationsDB>
{
  constructor(private config: CreateCrdtSchemaOptions) {}

  get tablesConfig() {
    return this.config.tables;
  }

  get migrations() {
    return this.config.migrations;
  }

  get "~clientSchema"() {
    console.warn("~clientSchema should not be accessed on the client");
    return null as any;
  }

  get "~serverSchema"() {
    console.warn("~serverSchema should not be accessed on the server");
    return null as any;
  }

  get "~mutationsSchema"() {
    console.warn("~mutationsSchema should not be accessed on the client");
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
      return new CrdtSchemaBuilder<
        ClientDB & { [K in CrdtTable]: Table } & { [K in BaseTable]: ReadonlyTable<Table> },
        ServerDB & { [K in BaseTable]: ReadonlyTable<Table> },
        MutationsDB & { [K in BaseTable]: Table }
      >(this.config);
    };

    return { withConfig };
  }

  build() {
    return this as SyncDbSchema<ClientDB, ServerDB, MutationsDB>;
  }
}

// biome-ignore lint/complexity/noBannedTypes: required generic
export interface SyncDbSchema<ClientDB = {}, ServerDB = {}, MutationsDB = {}> {
  get tablesConfig(): CrdtTableConfig[];
  get migrations(): Migrations;
  "~clientSchema": ClientDB;
  "~serverSchema": ServerDB;
  "~mutationsSchema": MutationsDB;
}

type ReadonlyTable<Table extends Record<string, unknown>> = {
  [K in keyof Table]: ColumnType<Table[K], never, never>;
};
