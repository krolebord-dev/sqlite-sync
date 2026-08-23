/**
 * Adapter-facing sqlite-sync internals.
 *
 * This entry point is not application API and may change without notice.
 */

export { baseSystemMigrations, createSystemDbConfig, runSystemMigrations } from "./migrations/system-schema";
export type { CrdtChangeIntent } from "./sqlite-crdt/crdt-storage";
export {
  CRDT_CHANGE_INTENTS_TABLE,
  createCrdtViewStatements,
  drainCrdtChangeIntents,
} from "./sqlite-crdt/make-crdt-table";
export type { InternalSQLiteWrapper, KyselyStatementFactory } from "./sqlite-db-wrapper";
