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
// Memory DB
export { SQLiteReactiveDb } from "./memory-db/sqlite-reactive-db";
// Migrations
export {
  createMigrations,
  createMigrator,
  type MigratableEvent,
  type Migrations,
  type MigrationsDb,
  type SyncDbMigrator,
} from "./migrations/migrator";
export { applyMemoryDbSchema, applyWorkerDbSchema } from "./migrations/system-schema";
// CRDT
export {
  createCrdtApplyFunction,
  createSQLiteCrdtApplyFunction,
  type PendingCrdtEvent,
} from "./sqlite-crdt/apply-crdt-event";
// CRDT Schema
export {
  type CreateCrdtSchemaOptions,
  createSyncDbSchema,
  type SyncDbSchema,
} from "./sqlite-crdt/crdt-schema";
export { type CrdtStorage, createCrdtStorage } from "./sqlite-crdt/crdt-storage";
export { type CrdtStorageMutator, createCrdtStorageMutator } from "./sqlite-crdt/crdt-storage-mutator";
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
  type PersistedCrdtEvent,
} from "./sqlite-crdt/crdt-table-schema";
export { applyKyselyEventsBatchFilters } from "./sqlite-crdt/events-batch-filters";
export { makeCrdtTable } from "./sqlite-crdt/make-crdt-table";
export { createStoredValue, type StoredValue } from "./sqlite-crdt/stored-value";
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
export { createKvStoreTableQuery, createSQLiteKvStore, type KvStoreItem } from "./sqlite-kv-store";
export { createSyncedDb, type SyncedDb } from "./sync-db";
// Utilities
export {
  createDeferredPromise,
  createTypedEventTarget,
  type DeferredPromise,
  type DistributiveOmit,
  generateId,
  jsonSafeParse,
  quoteId,
  TypedBroadcastChannel,
  TypedEvent,
  type TypedEventTarget,
  tryCatch,
  tryCatchAsync,
} from "./utils";
// Worker DB
export type {
  WorkerConfig,
  WorkerState,
} from "./worker-db/worker-common";
