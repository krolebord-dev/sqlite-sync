import type { ColumnType } from "kysely";
import type { Migrations } from "../migrations/migrator";
import type { SyncSchemaTables } from "../schema/table-builder";

export type CrdtTableConfig = {
  baseTableName: string;
  crdtTableName: string;
};

// biome-ignore lint/complexity/noBannedTypes: required generic
export interface SyncDbSchema<ClientDB = {}, ServerDB = {}, MutationsDB = {}> {
  get tablesConfig(): CrdtTableConfig[];
  get migrations(): Migrations;
  get tables(): SyncSchemaTables;
  "~clientSchema": ClientDB;
  "~serverSchema": ServerDB;
  "~mutationsSchema": MutationsDB;
}

export type ReadonlyTable<Table extends Record<string, unknown>> = {
  [K in keyof Table]: ColumnType<Table[K], never, never>;
};
