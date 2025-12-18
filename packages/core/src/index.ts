// Main exports

// Dummy Kysely for query compilation
export { dummyKysely } from "./dummy-kysely";

// HLC (Hybrid Logical Clock)
export {
  compareHLC,
  deserializeHLC,
  type HLC,
  HLCCounter,
  serializeHLC,
} from "./hlc";
// Introspection
export { type DatabaseIntrospection, introspectDb, type TableMetadata } from "./introspection";
// Logger
export { type Logger, type LogLevel, startPerformanceLogger } from "./logger";
export {
  createMemoryDb,
  type MemoryDbCrdtTableConfig,
} from "./memory-db/memory-db";

// Memory DB
export {
  createSQLiteReactiveDb,
  SQLiteReactiveDb,
} from "./memory-db/sqlite-reactive-db";
// Migrations
export { createSyncDbMigrations, createSyncDbMigrator } from "./migrations/migrator";
export { applyMemoryDbSchema, applyWorkerDbSchema } from "./migrations/system-schema";
// CRDT
export { applyCrdtEventMutations, type PendingCrdtEvent } from "./sqlite-crdt/apply-crdt-event";
export { type CrdtStorage, createCrdtStorage } from "./sqlite-crdt/crdt-storage";
export { createCrdtSyncProducer } from "./sqlite-crdt/crdt-sync-producer";
export {
  type CrdtSyncRemoteSource,
  createCrdtSyncRemoteSource,
  type EventsPullRequest,
  type EventsPushRequest,
  type EventsPushResponse,
} from "./sqlite-crdt/crdt-sync-remote-source";
export {
  type CrdtEventOrigin,
  type CrdtEventStatus,
  type CrdtEventType,
  type CrdtUpdateLogItem,
  type CrdtUpdateLogPayload,
  crdtSchema,
  type MetaItem,
  type PersistedCrdtEvent,
  registerCrdtFunctions,
} from "./sqlite-crdt/crdt-table-schema";
export { makeCrdtTable } from "./sqlite-crdt/make-crdt-table";
export { createSyncIdCounter, type SyncIdCounter } from "./sqlite-crdt/sync-id-counter";
// SQLite Wrapper
export {
  type ExecuteParams,
  type ExecuteResult,
  type KyselyQueryFactory,
  type PreparedStatement,
  type QueryBuilderOutput,
  SQLiteDbWrapper,
  type SQLiteTransactionWrapper,
} from "./sqlite-db-wrapper";
// SQLite Kysely integration
export { createSQLiteKysely, SqliteDriver } from "./sqlite-kysely";
export { createSyncedDb, type SyncedDb } from "./sync-db";

// Utilities
export {
  createAsyncAutoFlushBuffer,
  createAutoFlushBuffer,
  createDeferredPromise,
  createTypedEventTarget,
  type DeferredPromise,
  type DistributiveOmit,
  ensureSingletonExecution,
  generateId,
  jsonSafeParse,
  orderBy,
  TypedBroadcastChannel,
  TypedEvent,
} from "./utils";
// Worker DB Client
export {
  createWorkerDbClient,
  initializeWorkerDb,
} from "./worker-db/db-worker-client";
export {
  type AsyncRpc,
  broadcastChannelNames,
  createBroadcastChannels,
  type GetSnapshotResponse,
  isWorkerInitMessage,
  isWorkerInitResponse,
  isWorkerNotificationMessage,
  isWorkerRequestMessage,
  isWorkerResponseMessage,
  type PushTabEventsResponse,
  syncDbWorkerLockName,
  type WorkerBroadcastChannels,
  type WorkerConfig,
  type WorkerInitMessage,
  type WorkerInitResponse,
  type WorkerNotificationMessage,
  type WorkerRequestMessage,
  type WorkerRequestMethod,
  type WorkerResponseMessage,
  type WorkerRpc,
} from "./worker-db/worker-common";
