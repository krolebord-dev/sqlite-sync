import { type Kysely, type Migration, type MigrationProvider, Migrator } from "kysely";

class SyncMigrationsProvider implements MigrationProvider {
  private migrations: Record<string, Migration>;

  constructor(migrations: Record<string, Migration>) {
    this.migrations = migrations;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(this.migrations);
  }
}

type SyncDbMigratorOptions = {
  db: Kysely<unknown>;
  migrations: Record<string, Migration>;
};
export function createSyncDbMigrator(options: SyncDbMigratorOptions) {
  return new Migrator({
    db: options.db,
    provider: new SyncMigrationsProvider(options.migrations),
    allowUnorderedMigrations: false,
    migrationLockTableName: "worker.migration_lock",
    migrationTableName: "worker.migration",
  });
}

export function createSyncDbMigrations(migrations: Record<number, Migration>): Record<number, Migration> {
  return Object.fromEntries(Object.entries(migrations).map(([key, value]) => [key.toString().padStart(6, "0"), value]));
}
