import type { SqlValue } from "@sqlite.org/sqlite-wasm";
import type { Kysely } from "kysely";
import type { SystemDbConfig } from "../migrations/system-schema";
import type { InternalSQLiteWrapper } from "../sqlite-db-wrapper";
import { quoteId } from "../utils";
import {
  type CrdtEventType,
  type CrdtUpdateLogItem,
  type CrdtUpdateLogPayload,
  isNoOpCrdtEventPayload,
} from "./crdt-table-schema";

export type PendingCrdtEvent = {
  type: CrdtEventType;
  dataset: string;
  item_id: string;
  timestamp: string;
  payload: string;
};

export const createSQLiteCrdtApplyFunction = ({
  db,
  dbConfig,
}: {
  db: InternalSQLiteWrapper<any>;
  dbConfig: SystemDbConfig;
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
            .selectFrom(dbConfig.updateLogTable.fullIdentifier as "table")
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
          (db as unknown as Kysely<{ table: CrdtUpdateLogItem }>)
            .insertInto(dbConfig.updateLogTable.fullIdentifier as "table")
            .values({
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
            .updateTable(dbConfig.updateLogTable.fullIdentifier as "table")
            .set({
              payload: params("payload"),
            })
            .where("item_id", "=", params("item_id"))
            .where("dataset", "=", params("dataset")),
        { loggerLevel: "system" },
      );
    },
    insertItem(opts) {
      // Key by the sorted column set, not just the dataset: executePrepared caches
      // the compiled INSERT forever, freezing its column list. A later create event
      // omitting a column would otherwise bind undefined (-> NULL) against the stale
      // statement, bypassing the table DEFAULT. Sorting makes the key canonical so
      // events with the same columns in any order share one statement.
      const keys = Object.keys(opts.payload).sort();
      const insertPayload = {} as Record<string, unknown>;
      for (const key of keys) {
        insertPayload[key] = key;
      }
      db.executePrepared(
        `crdt-insert-item-${opts.dataset}-${keys.join("-")}`,
        opts.payload,
        (db) => db.insertInto(opts.dataset).values(insertPayload),
        { loggerLevel: "system" },
      );
    },
    updateItem(opts) {
      const keys = Array.from(Object.keys(opts.payload));
      keys.sort();
      db.executePreparedRaw({
        key: `update-item-${opts.dataset}-${keys.join("-")}`,
        sql: `update ${quoteId(opts.dataset)} set ${keys.map((key) => `${quoteId(key)} = ?`).join(",")} where id = ?`,
        params: [...keys.map((key) => opts.payload[key]), opts.itemId] as SqlValue[],
        meta: { loggerLevel: "system" },
      });
    },
  });

  return applyCrdtEvent;
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
  };
  const applyItemCreated = ({ event }: ItemCreatedOpts) => {
    const eventPayload = JSON.parse(event.payload);

    eventPayload.tombstone = 0;
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
    // A delete carries no field data on the wire — the tombstone is a local
    // materialization of the soft-delete, stamped here with the event's HLC so
    // it competes with concurrent field edits under the same last-write-wins rule.
    const eventPayload = event.type === "item-deleted" ? { tombstone: 1 } : JSON.parse(event.payload);

    const updatePayload = {} as Record<string, unknown>;
    let hasUpdates = false;

    for (const [key, value] of Object.entries(eventPayload)) {
      if (key === "id") {
        continue;
      }

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
    if (isNoOpCrdtEventPayload(event.payload)) {
      return;
    }

    const meta = getCrdtUpdateLog({
      itemId: event.item_id,
      dataset: event.dataset,
    });

    // TODO Check primary key / unique constraints

    if (event.type !== "item-created" && event.type !== "item-updated" && event.type !== "item-deleted") {
      throw new Error(`Unknown event type: ${event.type}`);
    }

    if (meta) {
      applyItemUpdated({ event, meta });
      return;
    }

    if (event.type === "item-created") {
      applyItemCreated({ event });
      return;
    }

    throw new Error(`Item ${event.item_id} in dataset ${event.dataset} not found`);
  };
}
