// Main exports

// Dummy Kysely for query compilation
export { dummyKysely } from "./dummy-kysely";
export {
  createExportData,
  createImportData,
  type ImportDataOptions,
  type ImportDataResult,
  type SyncedDbExport,
} from "./export-import";
export { xxhash } from "./hash";
// HLC (Hybrid Logical Clock)
export {
  compareHLC,
  deserializeHLC,
  type HLC,
  HLCCounter,
  serializeHLC,
} from "./hlc";
// Introspection
export { type ColumnMetadata, type DatabaseIntrospection, introspectDb, type TableMetadata } from "./introspection";
// Logger
export { type Logger, type LogLevel, startPerformanceLogger } from "./logger";
// Memory DB
export {
  parametersAreEqual,
  type SharedLiveQuery,
  type SharedLiveQuerySnapshot,
  SQLiteReactiveDb,
} from "./memory-db/sqlite-reactive-db";
// Migrations
export {
  createMigrations,
  createMigrator,
  type MigratableEvent,
  type Migrations,
  type MigrationsDb,
  type SyncDbMigrator,
} from "./migrations/migrator";
export {
  applyMemoryDbSchema,
  applyWorkerDbSchema,
  type SystemDbConfig,
  type SystemMigration,
  type SystemMigrationContext,
} from "./migrations/system-schema";
// Schema definition (defineSyncSchema)
export {
  type DefinedSyncSchema,
  type DefineSyncSchemaConfig,
  defineSyncSchema,
} from "./schema/define-sync-schema";
// Schema table builder (t.*)
export {
  type AnyColumnBuilder,
  type AnyTableBuilder,
  ColumnBuilder,
  type ColumnKind,
  type ColumnMeta,
  type InferRow,
  type PayloadValidationResult,
  type SqliteStorageType,
  type SyncSchemaTables,
  TableBuilder,
  type TableColumns,
  type TableOptions,
  t,
} from "./schema/table-builder";
export {
  CrdtEventValidationError,
  type NewCrdtEventValidationResult,
  validateNewCrdtEvent,
} from "./schema/validate-crdt-event";
// Schema verification (migrations ↔ declared schema drift check)
export {
  formatSchemaVerificationIssues,
  type SchemaVerificationIssue,
  verifySyncSchema,
} from "./schema/verify-sync-schema";
// CRDT
export {
  createCrdtApplyFunction,
  createSQLiteCrdtApplyFunction,
  type PendingCrdtEvent,
} from "./sqlite-crdt/apply-crdt-event";
// CRDT Schema
export type { CrdtTableConfig, ReadonlyTable, SyncDbSchema } from "./sqlite-crdt/crdt-schema";
export {
  type CrdtStorage,
  createCrdtStorage,
  type OwnCrdtEvent,
  type OwnCrdtSnapshot,
} from "./sqlite-crdt/crdt-storage";
export {
  type CrdtStorageMutator,
  createCrdtStorageMutator,
  type SnapshotOptions,
} from "./sqlite-crdt/crdt-storage-mutator";
export { createCrdtSyncProducer } from "./sqlite-crdt/crdt-sync-producer";
export {
  type CrdtSyncRemoteSource,
  createCrdtSyncRemoteSource,
  type EventsPullRequest,
  type EventsPushRequest,
  type EventsPushResponse,
} from "./sqlite-crdt/crdt-sync-remote-source";
export {
  CRDT_EVENT_NO_OP_PAYLOAD,
  type CrdtEventOrigin,
  type CrdtEventStatus,
  type CrdtEventType,
  type CrdtUpdateLogItem,
  type CrdtUpdateLogPayload,
  isNoOpCrdtEventPayload,
  type PersistedCrdtEvent,
} from "./sqlite-crdt/crdt-table-schema";
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
export {
  createSyncedDb,
  type SyncedDb,
  type SyncedDbDatabase,
  type SyncedDbOptions,
  type SyncedDbSqlExecutor,
  type SyncedDbTransaction,
  type UnsafeSyncedDbSqlExecutor,
} from "./sync-db";
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
export { RESET_REQUEST_TTL_MS, type ResetRequest, type ResetStore } from "./worker-db/reset-state";
export type {
  WorkerConfig,
  WorkerNotificationMessage,
  WorkerState,
} from "./worker-db/worker-common";
