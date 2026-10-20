import { validateDbId } from "../db-id";
import { getOrCreateSQLiteSyncDevtoolsRegistry } from "../devtools-registry";
import { createExportData, createImportData } from "../export-import";
import { xxhash } from "../hash";
import { HLCCounter } from "../hlc";
import type { Logger } from "../logger";
import { SQLiteReactiveDb } from "../memory-db/sqlite-reactive-db";
import { createMigrator } from "../migrations/migrator";
import {
  applyLocalDbSchema,
  LOCAL_KV_TABLE_NAME,
  type LocalDbSchema,
  localDbConfig,
} from "../migrations/system-schema";
import { formatSchemaVerificationIssues, verifySyncSchemaWithDriver } from "../schema/verify-sync-schema";
import type { SyncDbSchema } from "../sqlite-crdt/crdt-schema";
import { createCrdtStorage } from "../sqlite-crdt/crdt-storage";
import { createCrdtSyncProducer } from "../sqlite-crdt/crdt-sync-producer";
import {
  type CreateRemoteSourceFactory,
  createCrdtSyncRemoteSource,
  PUSH_BATCH_SIZE,
} from "../sqlite-crdt/crdt-sync-remote-source";
import { makeCrdtTable, registerCrdtIntentDrainer } from "../sqlite-crdt/make-crdt-table";
import type { SqliteDriver } from "../sqlite-driver";
import { createKvStateHashStore, createKvStoreTableQuery, createSQLiteKvStore } from "../sqlite-kv-store";
import type { SyncedDb } from "../sync-db";
import { createSyncedDbDatabase } from "../synced-db-database";
import { createTypedEventTarget, generateId } from "../utils";
import { runWorkerEventLogGc } from "../worker-db/event-log-gc";
import { formatStorageVersion } from "../worker-db/storage-version";
import type { WorkerNotificationEvents, WorkerNotificationMessage } from "../worker-db/worker-common";

export type LocalSyncedDbOptions<Database> = {
  dbId: string;
  syncDbSchema: SyncDbSchema<Database>;
  /** Opens the persisted database. Called again after a reset deleted it. */
  openDriver: () => SqliteDriver | Promise<SqliteDriver>;
  /** Deletes the persisted database. Only called while no connection to it is open. */
  deleteDatabase: () => void | Promise<void>;
  createRemoteSource?: CreateRemoteSourceFactory;
  logger?: Logger;
  /**
   * App-provided storage version, combined with the library's internal storage
   * version. Bump it when deploying a code change that old persisted local DBs
   * cannot survive — on mismatch the local DB is deleted on startup.
   */
  storageVersion?: string;
  /**
   * Dev-time drift check: replays the full migration history on a throwaway
   * database opened by this callback and verifies the result matches the schema
   * declared with `defineSyncSchema`. On mismatch startup throws.
   */
  verifySchemaDriver?: () => SqliteDriver | Promise<SqliteDriver>;
  /**
   * Runs event-log garbage collection on startup. Disabled by default. GC keeps the
   * latest event rows and never removes pending events or local rows that have not
   * been pushed to the remote.
   */
  eventLogGc?: boolean;
  /** Runs once when the instance is disposed, including by `requestReload`. */
  onDispose?: () => void;
};

export type LocalSyncedDb<Database> = SyncedDb<Database> & {
  state: SyncedDb<Database>["state"] & {
    /** Drops the remote connection without retrying; call `sync` once the network is back. */
    dropConnection: () => void;
  };
};

const STORAGE_VERSION_KEY = "storage-version";

const defaultLogger: Logger = (type, message, level = "info") => {
  const logMessage = `[${type}] ${message}`;
  switch (level) {
    case "info":
      console.log(logMessage);
      break;
    case "warning":
      console.warn(logMessage);
      break;
    case "error":
      console.error(logMessage);
      break;
    case "trace":
      console.trace(logMessage);
      break;
  }
};

/**
 * A synced DB backed by a single persisted SQLite connection, for runtimes with one
 * JS context per database (React Native, Electron, Node). Reads and writes go to the
 * persisted database directly; there is no worker, tab coordination or in-memory copy.
 */
export async function createLocalSyncedDb<Database>(
  options: LocalSyncedDbOptions<Database>,
): Promise<LocalSyncedDb<Database>> {
  validateDbId(options.dbId);
  const logger = options.logger ?? defaultLogger;

  if (options.verifySchemaDriver) {
    const issues = verifySyncSchemaWithDriver(options.syncDbSchema as SyncDbSchema, await options.verifySchemaDriver());
    if (issues.length > 0) {
      throw new Error(formatSchemaVerificationIssues(issues));
    }
    logger("local", "Schema verification passed: migrations match the declared schema", "info");
  }

  await xxhash.ensureLoaded();

  const reactiveDb = await openLocalReactiveDb(options, logger);
  const db = reactiveDb.db as unknown as SQLiteReactiveDb<LocalDbSchema>["db"];

  try {
    const { kvStore } = applyLocalDbSchema(db);

    const migrator = createMigrator({
      migrations: options.syncDbSchema.migrations,
      schemaVersion: kvStore.createNumberStoredValue("schema-version", -1),
      updateLogTableName: localDbConfig.updateLogTable.fullIdentifier,
    });
    migrator.migrateDbToLatest({
      startTransaction: (callback) => {
        db.executeTransaction((tx) =>
          callback({ execute: (sql, parameters, meta) => tx.execute({ sql, parameters }, meta) }),
        );
      },
    });
    db.invalidateDbSchema();

    const pullSyncId = kvStore.createNumberStoredValue("pull-sync-id", -1);
    const pushSyncId = kvStore.createNumberStoredValue("push-sync-id", -1);
    const stateHash = createKvStateHashStore(kvStore);
    const storageGeneration = kvStore.createStringStoredValue("storage-generation", "");
    if (!storageGeneration.current) {
      storageGeneration.current = generateId();
    }

    if (options.eventLogGc === true) {
      runWorkerEventLogGc({ db, dbConfig: localDbConfig, pushSyncId, logger });
    }

    for (const table of options.syncDbSchema.tablesConfig) {
      makeCrdtTable({ db, baseTableName: table.baseTableName, crdtTableName: table.crdtTableName, temp: true });
    }

    const nodeId = generateId();
    const crdtStorage = createCrdtStorage({
      nodeId,
      initialLocalSyncId: getMaxSyncId(db),
      migrator,
      hlc: new HLCCounter(nodeId, () => Date.now()),
      db,
      dbConfig: localDbConfig,
      stateHash,
      schema: options.syncDbSchema,
    });
    registerCrdtIntentDrainer({ reactiveDb, storage: crdtStorage });

    kvStore.set(STORAGE_VERSION_KEY, formatStorageVersion(options.storageVersion));

    const eventTarget = createTypedEventTarget<WorkerNotificationEvents>();
    const notify = (notification: WorkerNotificationMessage) => {
      eventTarget.dispatchEvent(notification.notificationType, notification as never);
    };

    createCrdtSyncProducer({
      storage: crdtStorage,
      broadcastEvents: (chunk) => {
        notify({
          notificationType: "new-event-chunk-applied",
          newSyncId: chunk.newSyncId,
          stateHash: chunk.stateHash,
        });
      },
    });

    const remoteSource = createCrdtSyncRemoteSource({
      bufferSize: PUSH_BATCH_SIZE,
      pullSyncId,
      pushSyncId,
      nodeId,
      storage: crdtStorage,
      migrator,
      remoteFactory: options.createRemoteSource,
    });
    remoteSource.addEventListener("state-changed", () => {
      notify({
        notificationType: "state-changed",
        state: remoteSource.getState(),
        storageGeneration: storageGeneration.current,
      });
    });
    remoteSource.addEventListener("de-sync-detected", (event) => {
      notify({ notificationType: "de-sync-detected", reason: event.payload.reason });
    });
    remoteSource.addEventListener("remote-schema-version-mismatch", (event) => {
      notify({
        notificationType: "remote-schema-version-mismatch",
        remoteSchemaVersion: event.payload.remoteSchemaVersion,
        localSchemaVersion: event.payload.localSchemaVersion,
      });
    });
    remoteSource.goOnline();

    let unregisterDevtools: (() => void) | undefined;
    let disposePromise: Promise<void> | null = null;
    const dispose = () => {
      disposePromise ??= (async () => {
        options.onDispose?.();
        unregisterDevtools?.();
        try {
          await remoteSource.dispose();
          await crdtStorage.internal.processEnqueuedEvents();
        } finally {
          reactiveDb.dispose();
        }
      })();
      return disposePromise;
    };

    const importData = createImportData({
      migrator,
      tablesConfig: options.syncDbSchema.tablesConfig,
      applyEvents: async (events) => {
        crdtStorage.applyOwnEvents(events);
        await crdtStorage.internal.processEnqueuedEvents();
      },
    });

    const sync = () => {
      remoteSource.syncWithRemote().catch((error) => console.warn("Failed to start sync", error));
    };

    const syncedDb: LocalSyncedDb<Database> = {
      db: createSyncedDbDatabase(reactiveDb),
      state: {
        getState: () => remoteSource.getState(),
        subscribe: (onChange: () => void) => {
          const { unsubscribe } = eventTarget.addEventListener("state-changed", onChange);
          return unsubscribe;
        },
        goOnline: () => remoteSource.goOnline(),
        goOffline: () => remoteSource.goOffline("DISCONNECTED"),
        dropConnection: () => remoteSource.dropConnection("NETWORK_OFFLINE"),
        sync,
      },
      /**
       * Disposes this instance and notifies `reload-requested` subscribers, which are
       * expected to create a new instance. With `clean: true` the persisted database is
       * deleted first, so the next instance starts empty and re-syncs from the remote.
       * Pending local events that were not pushed yet are lost with a clean reload.
       */
      requestReload: async ({ clean }: { clean: boolean }) => {
        await dispose();
        if (clean) {
          await options.deleteDatabase();
        }
        notify({ notificationType: "reload-requested", reloadEpoch: generateId(), clean });
      },
      subscribe: eventTarget.addEventListener,
      exportData: createExportData({
        reactiveDb,
        tablesConfig: options.syncDbSchema.tablesConfig,
        schemaVersion: migrator.currentSchemaVersion,
      }),
      importData: async (data, opts) => importData(data, opts),
      dispose,
      _internal: {
        executeAsync: async (query) => reactiveDb.db.execute(query),
        getMemoryQueryTables: reactiveDb.getTablesUsed.bind(reactiveDb),
        getSharedLiveQueriesSnapshot: reactiveDb.getSharedLiveQueriesSnapshot.bind(reactiveDb),
        crdtTableNames: options.syncDbSchema.tablesConfig.map((table) => table.crdtTableName),
        crdtTablesConfig: options.syncDbSchema.tablesConfig,
        tables: options.syncDbSchema.tables,
        schemaVersion: migrator.currentSchemaVersion,
        migrationVersions: Object.keys(options.syncDbSchema.migrations)
          .map(Number)
          .sort((a, b) => a - b),
      },
    };

    unregisterDevtools = getOrCreateSQLiteSyncDevtoolsRegistry().register({
      instanceId: generateId(),
      dbId: options.dbId,
      createdAt: Date.now(),
      instance: syncedDb,
    });

    return syncedDb;
  } catch (error) {
    reactiveDb.dispose();
    throw error;
  }
}

async function openLocalReactiveDb<Database>(options: LocalSyncedDbOptions<Database>, logger: Logger) {
  const open = async () => {
    const driver = await options.openDriver();
    const reactiveDb = SQLiteReactiveDb.create<Database>({ driver, logger, loggerPrefix: "local" });
    try {
      reactiveDb.db.execute("PRAGMA journal_mode=WAL", { loggerLevel: "system" });
      reactiveDb.db.execute("PRAGMA synchronous=NORMAL", { loggerLevel: "system" });
      reactiveDb.db.executeKysely((kysely) => createKvStoreTableQuery(kysely.schema, LOCAL_KV_TABLE_NAME), {
        loggerLevel: "system",
      });
    } catch (error) {
      reactiveDb.dispose();
      throw error;
    }
    return reactiveDb;
  };

  const reactiveDb = await open();
  const currentVersion = formatStorageVersion(options.storageVersion);
  const storedVersion = createSQLiteKvStore({ db: reactiveDb.db, metaTableName: LOCAL_KV_TABLE_NAME }).get(
    STORAGE_VERSION_KEY,
  );
  if (storedVersion === null || storedVersion === currentVersion) {
    return reactiveDb;
  }

  logger("local", `Storage version mismatch — resetting local DB to ${currentVersion}`, "warning");
  reactiveDb.dispose();
  await options.deleteDatabase();
  return open();
}

function getMaxSyncId(db: SQLiteReactiveDb<LocalDbSchema>["db"]) {
  const [result] = db.executePrepared(
    "get-max-sync-id",
    {},
    (db) => db.selectFrom("crdt_events").select((eb) => eb.fn.max("sync_id").as("sync_id")),
    { loggerLevel: "system" },
  );

  return result?.sync_id ?? 0;
}
