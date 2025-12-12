// Main exports
export { createSyncedDb, type SyncedDb } from "./sync-db";

// HLC (Hybrid Logical Clock)
export {
  HLCCounter,
  serializeHLC,
  deserializeHLC,
  compareHLC,
  type HLC,
} from "./hlc";

// SQLite Wrapper
export {
  SQLiteDbWrapper,
  type ExecuteParams,
  type ExecuteResult,
  type PreparedStatement,
  type SQLiteTransactionWrapper,
  type QueryBuilderOutput,
  type KyselyQueryFactory,
} from "./sqlite-db-wrapper";

// SQLite Kysely integration
export { SqliteDriver, createSQLiteKysely } from "./sqlite-kysely";

// Dummy Kysely for query compilation
export { dummyKysely } from "./dummy-kysely";

// Memory DB
export {
  createSQLiteReactiveDb,
  SQLiteReactiveDb,
} from "./memory-db/sqlite-reactive-db";
export {
  createMemoryDb,
  type MemoryDbCrdtTableConfig,
} from "./memory-db/memory-db";

// Migrations
export { createSyncDbMigrator, createSyncDbMigrations } from "./migrations/migrator";
export { applyWorkerDbSchema, applyMemoryDbSchema } from "./migrations/system-schema";

// CRDT
export { applyCrdtEventMutations, type PendingCrdtEvent } from "./sqlite-crdt/apply-crdt-event";
export { createCrdtStorage, type CrdtStorage } from "./sqlite-crdt/crdt-storage";
export { createCrdtSyncProducer } from "./sqlite-crdt/crdt-sync-producer";
export {
  createCrdtSyncRemoteSource,
  type CrdtSyncRemoteSource,
  type EventsPullRequest,
  type EventsPullResponse,
  type EventsPushRequest,
  type EventsPushResponse,
} from "./sqlite-crdt/crdt-sync-remote-source";
export {
  crdtSchema,
  registerCrdtFunctions,
  type CrdtEventType,
  type CrdtEventStatus,
  type CrdtEventOrigin,
  type PersistedCrdtEvent,
  type CrdtUpdateLogItem,
  type CrdtUpdateLogPayload,
  type MetaItem,
} from "./sqlite-crdt/crdt-table-schema";
export { makeCrdtTable } from "./sqlite-crdt/make-crdt-table";
export { createSyncIdCounter, type SyncIdCounter } from "./sqlite-crdt/sync-id-counter";

// Worker DB Client
export {
  createWorkerDbClient,
  initializeWorkerDb,
} from "./worker-db/db-worker-client";
export {
  createBroadcastChannels,
  syncDbWorkerLockName,
  broadcastChannelNames,
  isWorkerInitMessage,
  isWorkerInitResponse,
  isWorkerRequestMessage,
  isWorkerResponseMessage,
  isWorkerNotificationMessage,
  type WorkerConfig,
  type SyncServerConfig,
  type WorkerRpc,
  type WorkerRequestMethod,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
  type WorkerNotificationMessage,
  type WorkerBroadcastChannels,
  type WorkerInitMessage,
  type WorkerInitResponse,
  type AsyncRpc,
  type PushTabEventsResponse,
  type GetSnapshotResponse,
} from "./worker-db/worker-common";

// Utilities
export {
  generateId,
  createDeferredPromise,
  ensureSingletonExecution,
  orderBy,
  createAutoFlushBuffer,
  createAsyncAutoFlushBuffer,
  TypedBroadcastChannel,
  TypedEvent,
  createTypedEventTarget,
  jsonSafeParse,
  type DeferredPromise,
  type DistributiveOmit,
} from "./utils";

// Logger
export { startPerformanceLogger, type Logger, type LogLevel } from "./logger";

// Introspection
export { introspectDb, type TableMetadata, type DatabaseIntrospection } from "./introspection";
