import type { Kysely } from "kysely";
import type { SQLiteTransactionWrapper } from "../sqlite-db-wrapper";
import type { CrdtEventType, CrdtUpdateLogItem, CrdtUpdateLogPayload } from "./crdt-table-schema";

export type PendingCrdtEvent = {
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  timestamp: string;
  payload: string;
};

export const createSQLiteCrdtApplyFunction = ({
  db,
  updateLogTableName,
  wrapInSavepoint = false,
}: {
  db: SQLiteTransactionWrapper<any>;
  updateLogTableName: string;
  wrapInSavepoint: boolean;
}) => {
  const applyCrdtEvent = createCrdtApplyFunction({
    getCrdtUpdateLog(opts) {
      const [metaRow] = db.executePrepared(
        "get-item-crdt-meta",
        {
          item_id: opts.itemId,
          dataset: opts.dataset,
        },
        (db, params) => {
          return (db as unknown as Kysely<{ table: CrdtUpdateLogItem }>)
            .selectFrom(updateLogTableName as "table")
            .select("payload")
            .where("item_id", "=", params("item_id"))
            .where("dataset", "=", params("dataset"));
        },
        { loggerLevel: "system" },
      );
      const meta = metaRow ? (JSON.parse(metaRow.payload) as CrdtUpdateLogPayload) : null;
      return meta;
    },
    insertCrdtUpdateLog(opts) {
      db.executePrepared(
        "insert-crdt-update-log",
        {
          item_id: opts.itemId,
          dataset: opts.dataset,
          payload: opts.payload,
        },
        (db, params) =>
          (db as unknown as Kysely<{ table: CrdtUpdateLogItem }>).insertInto(updateLogTableName as "table").values({
            item_id: params("item_id"),
            dataset: params("dataset"),
            payload: params("payload"),
          }),
        { loggerLevel: "system" },
      );
    },
    updateCrdtUpdateLog(opts) {
      db.executePrepared(
        "update-crdt-update-log",
        {
          item_id: opts.itemId,
          dataset: opts.dataset,
          payload: opts.payload,
        },
        (db, params) =>
          (db as unknown as Kysely<{ table: CrdtUpdateLogItem }>)
            .updateTable(updateLogTableName as "table")
            .set({
              payload: params("payload"),
            })
            .where("item_id", "=", params("item_id"))
            .where("dataset", "=", params("dataset")),
        { loggerLevel: "system" },
      );
    },
    insertItem(opts) {
      const insertPayload = {} as Record<string, unknown>;
      for (const key of Object.keys(opts.payload)) {
        insertPayload[key] = key;
      }
      db.executePrepared(
        `crdt-insert-item-${opts.dataset}`,
        opts.payload,
        (db) => db.insertInto(opts.dataset).values(insertPayload),
        { loggerLevel: "system" },
      );
    },
    updateItem(opts) {
      const keys = Array.from(Object.keys(opts.payload));
      db.execute(
        {
          sql: `update ${opts.dataset} set ${keys.map((key) => `${key} = ?`).join(",")} where id = ?`,
          parameters: [...keys.map((key) => opts.payload[key]), opts.itemId],
        },
        { loggerLevel: "system" },
      );
    },
  });

  if (!wrapInSavepoint) {
    return applyCrdtEvent;
  }

  const savepoint = db.prepare("savepoint apply_crdt_event;", { loggerLevel: "system" });
  const rollbackToSavepoint = db.prepare("rollback to savepoint apply_crdt_event;", { loggerLevel: "system" });
  const releaseSavepoint = db.prepare("release savepoint apply_crdt_event;", { loggerLevel: "system" });

  return (event: PendingCrdtEvent) => {
    savepoint.execute([]);
    try {
      applyCrdtEvent(event);
      releaseSavepoint.execute([]);
    } catch (error) {
      rollbackToSavepoint.execute([]);
      throw error;
    }
  };
};

type CreateCrdtApplyOpts = {
  getCrdtUpdateLog: (opts: { itemId: string; dataset: string }) => CrdtUpdateLogPayload | null;
  insertItem: (opts: { dataset: string; payload: Record<string, unknown> }) => void;
  insertCrdtUpdateLog: (opts: { dataset: string; itemId: string; payload: string }) => void;
  updateItem: (opts: { dataset: string; itemId: string; payload: Record<string, unknown> }) => void;
  updateCrdtUpdateLog: (opts: { dataset: string; itemId: string; payload: string }) => void;
};

export function createCrdtApplyFunction({
  getCrdtUpdateLog,
  insertItem,
  insertCrdtUpdateLog,
  updateItem,
  updateCrdtUpdateLog,
}: CreateCrdtApplyOpts) {
  type ItemCreatedOpts = {
    event: PendingCrdtEvent;
    meta: CrdtUpdateLogPayload | null;
  };
  const applyItemCreated = ({ event, meta }: ItemCreatedOpts) => {
    if (meta) {
      // Item already exists
      applyItemUpdated({ event, meta });
      return;
    }

    const eventPayload = JSON.parse(event.payload);

    eventPayload.tombstone = false;
    insertItem({ dataset: event.dataset, payload: eventPayload });

    const newUpdateLog = {} as Record<string, string>;
    for (const key of Object.keys(eventPayload)) {
      newUpdateLog[key] = event.timestamp;
    }

    insertCrdtUpdateLog({
      dataset: event.dataset,
      itemId: event.item_id,
      payload: JSON.stringify(newUpdateLog),
    });
  };

  type ItemUpdatedOpts = {
    event: PendingCrdtEvent;
    meta: CrdtUpdateLogPayload;
  };
  const applyItemUpdated = ({ event, meta }: ItemUpdatedOpts) => {
    if (!meta) {
      throw new Error(`Item ${event.item_id} in dataset ${event.dataset} not found`);
    }
    const eventPayload = JSON.parse(event.payload);

    const updatePayload = {} as Record<string, unknown>;
    let hasUpdates = false;

    for (const [key, value] of Object.entries(eventPayload)) {
      const lastUpdateTimestamp = meta[key];
      const currentUpdateTimestamp = event.timestamp;

      if (!lastUpdateTimestamp || !currentUpdateTimestamp || currentUpdateTimestamp > lastUpdateTimestamp) {
        updatePayload[key] = value;
        meta[key] = currentUpdateTimestamp;
        hasUpdates = true;
      }
    }

    if (!hasUpdates) {
      return;
    }

    updateItem({
      dataset: event.dataset,
      itemId: event.item_id,
      payload: updatePayload,
    });
    updateCrdtUpdateLog({
      dataset: event.dataset,
      itemId: event.item_id,
      payload: JSON.stringify(meta),
    });
  };

  return (event: PendingCrdtEvent) => {
    const meta = getCrdtUpdateLog({
      itemId: event.item_id,
      dataset: event.dataset,
    });

    // TODO Check primary key / unique constraints

    switch (event.type) {
      case "item-created": {
        applyItemCreated({
          event,
          meta,
        });
        break;
      }
      case "item-updated": {
        if (!meta) {
          throw new Error(`Item ${event.item_id} in dataset ${event.dataset} not found`);
        }

        applyItemUpdated({
          event,
          meta,
        });
        break;
      }
      default:
        event.type satisfies never;
    }
  };
}
