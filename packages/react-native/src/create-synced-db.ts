import { open } from "@op-engineering/op-sqlite";
import type { Logger, SyncDbSchema } from "@sqlite-sync/core";
import { type CreateRemoteSourceFactory, createLocalSyncedDb, type LocalSyncedDb } from "@sqlite-sync/core/local";
import { AppState } from "react-native";
import { createOpSqliteDriver } from "./op-sqlite-driver";

type OpenOptions = Parameters<typeof open>[0];

export type SyncedDbOptions<Database> = {
  /** Names the database file (`<dbId>.sqlite`). */
  dbId: string;
  syncDbSchema: SyncDbSchema<Database>;
  createRemoteSource?: CreateRemoteSourceFactory;
  /** Directory for the database file. Defaults to op-sqlite's default location. */
  location?: OpenOptions["location"];
  /** Requires op-sqlite built with SQLCipher. */
  encryptionKey?: OpenOptions["encryptionKey"];
  logger?: Logger;
  /**
   * App-provided storage version, combined with the library's internal storage
   * version. Bump it when deploying a code change that old persisted local DBs
   * cannot survive — on mismatch the local DB is deleted on startup.
   */
  storageVersion?: string;
  /**
   * Dev-time drift check: replays the full migration history on an in-memory
   * database and verifies the result matches the declared schema. Enable in
   * development only, e.g. `verifySchema: __DEV__`.
   */
  verifySchema?: boolean;
  /** Runs event-log garbage collection on startup. Disabled by default. */
  eventLogGc?: boolean;
  /**
   * Syncs when the app returns to the foreground and drops the remote connection
   * when it goes to the background. Enabled by default.
   */
  syncOnAppStateChange?: boolean;
};

export type SyncedDb<Database> = LocalSyncedDb<Database>;

export async function createSyncedDb<Database>(options: SyncedDbOptions<Database>): Promise<SyncedDb<Database>> {
  // op-sqlite reads every present option key as a string, so unset ones must be left out.
  const openOptions: OpenOptions = { name: `${options.dbId}.sqlite` };
  if (options.location !== undefined) openOptions.location = options.location;
  if (options.encryptionKey !== undefined) openOptions.encryptionKey = options.encryptionKey;
  let removeAppStateListener: (() => void) | undefined;

  const syncedDb = await createLocalSyncedDb<Database>({
    dbId: options.dbId,
    syncDbSchema: options.syncDbSchema,
    createRemoteSource: options.createRemoteSource,
    logger: options.logger,
    storageVersion: options.storageVersion,
    eventLogGc: options.eventLogGc,
    openDriver: () => createOpSqliteDriver(open(openOptions)),
    deleteDatabase: () => open(openOptions).delete(),
    verifySchemaDriver: options.verifySchema
      ? () => createOpSqliteDriver(open({ name: `${options.dbId}-verify`, location: ":memory:" }))
      : undefined,
    onDispose: () => removeAppStateListener?.(),
  });

  if (options.syncOnAppStateChange !== false) {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        syncedDb.state.sync();
      } else if (state === "background") {
        syncedDb.state.dropConnection();
      }
    });
    removeAppStateListener = () => subscription.remove();
  }

  return syncedDb;
}
