// Server utilities and types
export {
  syncServerRequestSchema,
  type SyncServerMessage,
  type SyncServerRequest,
  type ExtractSyncServerRequest,
} from "./server/server-common";

// Re-export CRDT types commonly used on the server
export {
  crdtSchema,
  type PersistedCrdtEvent,
  type CrdtEventStatus,
} from "./sqlite-crdt/crdt-table-schema";

export { createCrdtStorage, type CrdtStorage } from "./sqlite-crdt/crdt-storage";
export { createSyncIdCounter, type SyncIdCounter } from "./sqlite-crdt/sync-id-counter";
export { createCrdtSyncProducer } from "./sqlite-crdt/crdt-sync-producer";

// Utilities
export {
  jsonSafeParse,
  createDeferredPromise,
  type DeferredPromise,
} from "./utils";

// Dummy Kysely for server-side query building
export { dummyKysely } from "./dummy-kysely";

