import { type CrdtUpdateLogItem, crdtSchema, type PersistedCrdtEvent } from "../sqlite-crdt/crdt-table-schema";
import type { SQLiteDbWrapper } from "../sqlite-db-wrapper";
import { createMetaTableQuery, type MetaItem } from "../sqlite-kv-store";

export type WorkerDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  "worker.meta": MetaItem;
  "worker.crdt_events": PersistedCrdtEvent;
};

export function applyWorkerDbSchema(db: SQLiteDbWrapper<any>) {
  db.executeTransaction((db) => {
    db.executeKysely((kysely) => createMetaTableQuery(kysely.schema, "worker.meta"), { loggerLevel: "system" });
    db.executeKysely((kysely) => crdtSchema.crdtUpdateLogTable(kysely.schema, "crdt_update_log"), {
      loggerLevel: "system",
    });
    db.executeKysely((kysely) => crdtSchema.persistedEventsTable(kysely.schema, "worker.crdt_events"), {
      loggerLevel: "system",
    });
  });
}

export type MemoryDbSchema = {
  crdt_update_log: CrdtUpdateLogItem;
  persisted_crdt_events: PersistedCrdtEvent;
};

export function applyMemoryDbSchema(db: SQLiteDbWrapper<any>) {
  db.executeKysely((kysely) => crdtSchema.crdtUpdateLogTable(kysely.schema, "crdt_update_log"), {
    loggerLevel: "system",
  });
  db.executeKysely((kysely) => crdtSchema.persistedEventsTable(kysely.schema, "persisted_crdt_events"), {
    loggerLevel: "system",
  });
}
