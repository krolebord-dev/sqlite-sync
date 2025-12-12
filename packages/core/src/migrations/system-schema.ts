import {
  crdtSchema,
  type PersistedCrdtEvent,
  type CrdtUpdateLogItem,
  type MetaItem,
} from "../sqlite-crdt/crdt-table-schema";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";

export type WorkerDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  ["worker.meta"]: MetaItem;
  ["worker.crdt_events"]: PersistedCrdtEvent;
};

export function applyWorkerDbSchema(db: SQLiteDbWrapper<any>) {
  db.executeTransaction((db) => {
    db.executeKysely((kysely) =>
      crdtSchema.metaTable(kysely.schema, "worker.meta")
    );
    db.executeKysely((kysely) =>
      crdtSchema.crdtUpdateLogTable(kysely.schema, "crdt_update_log")
    );
    db.executeKysely((kysely) =>
      crdtSchema.persistedEventsTable(kysely.schema, "worker.crdt_events")
    );
  });
}

export type MemoryDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  persisted_crdt_events: PersistedCrdtEvent;
};

export function applyMemoryDbSchema(db: SQLiteDbWrapper<any>) {
  db.executeKysely((kysely) =>
    crdtSchema.crdtUpdateLogTable(kysely.schema, "crdt_update_log")
  );
  db.executeKysely((kysely) =>
    crdtSchema.persistedEventsTable(kysely.schema, "persisted_crdt_events")
  );
}

