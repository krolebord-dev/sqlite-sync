// Worker entry point - for use in Web Workers
export { startDbWorker } from "./worker-db/db-worker";

// Re-export types needed for worker configuration
export type {
  EventsPullRequest,
  EventsPullResponse,
  EventsPushRequest,
  EventsPushResponse,
} from "./sqlite-crdt/crdt-sync-remote-source";

export type { Migration } from "kysely";

