import {
  crdtSchema,
  type AppliedCrdtEvent,
  type CrdtUpdateLogItem,
  type PersistedCrdtEvent,
} from "../sqlite-crdt/crdt-table-schema";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";

export type WorkerDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  ["worker.crdt_events"]: AppliedCrdtEvent;
  ["worker.pending_crdt_events"]: PersistedCrdtEvent;
};

export function applyWorkerDbSchema(db: SQLiteDbWrapper<any>) {
  db.executeTransaction((db) => {
    db.executeKysely((kysely) =>
      crdtSchema.crdtUpdateLogTable(kysely.schema, "crdt_update_log")
    );
    db.executeKysely((kysely) =>
      crdtSchema.appliedEventsTable(kysely.schema, "worker.crdt_events")
    );
    db.executeKysely((kysely) =>
      crdtSchema.pendingEventsTable(kysely.schema, "worker.pending_crdt_events")
    );
  });
}

export type MemoryDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  pending_crdt_events: PersistedCrdtEvent;
};

export function applyMemoryDbSchema(db: SQLiteDbWrapper<any>) {
  db.executeKysely((kysely) =>
    crdtSchema.crdtUpdateLogTable(kysely.schema, "crdt_update_log")
  );
  db.executeKysely((kysely) =>
    crdtSchema.pendingEventsTable(kysely.schema, "pending_crdt_events")
  );
}
