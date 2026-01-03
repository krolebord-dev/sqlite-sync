// Server utilities and types

// Dummy Kysely for server-side query building
export { dummyKysely } from "./dummy-kysely";
export {
  type ExtractSyncServerRequest,
  type SyncServerMessage,
  type SyncServerRequest,
  syncServerRequestSchema,
} from "./server/server-common";
export { type CrdtStorage, createCrdtStorage } from "./sqlite-crdt/crdt-storage";
export { createCrdtSyncProducer } from "./sqlite-crdt/crdt-sync-producer";
// Re-export CRDT types commonly used on the server
export {
  type CrdtEventStatus,
  crdtSchema,
  type PersistedCrdtEvent,
} from "./sqlite-crdt/crdt-table-schema";
export { applyKyselyEventsBatchFilters } from "./sqlite-crdt/events-batch-filters";
export { createStoredValue, type StoredValue } from "./sqlite-crdt/stored-value";
// Utilities
export {
  createDeferredPromise,
  type DeferredPromise,
  jsonSafeParse,
} from "./utils";
