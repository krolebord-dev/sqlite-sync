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

type ApplyCrdtParams = {
  updateLogTableName: string;
  db: SQLiteTransactionWrapper<any>;
  event: PendingCrdtEvent;
};

type ApplyCrdtContext = {
  db: SQLiteTransactionWrapper<unknown>;
  updateLogTableName: string;
  event: PendingCrdtEvent;
  eventPayload: Record<string, unknown>;
  meta: CrdtUpdateLogPayload | null;
};

export function applyCrdtEventMutations({ db, event, updateLogTableName }: ApplyCrdtParams) {
  const eventPayload = JSON.parse(event.payload);

  const [metaRow] = db.executePrepared(
    "get-item-crdt-meta",
    {
      item_id: event.item_id,
      dataset: event.dataset,
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

  // TODO Check primary key / unique constraints

  const context: ApplyCrdtContext = {
    db: db as SQLiteTransactionWrapper<unknown>,
    updateLogTableName,
    event,
    meta,
    eventPayload,
  };

  switch (event.type) {
    case "item-created": {
      applyItemCreated(context);
      break;
    }
    case "item-updated": {
      applyItemUpdated(context);
      break;
    }
    default:
      event.type satisfies never;
  }
}

function applyItemCreated(context: ApplyCrdtContext) {
  if (context.meta) {
    // Item already exists
    applyItemUpdated(context);
    return;
  }

  // TODO SQL sanitization

  context.eventPayload.tombstone = false;
  const keys = Array.from(Object.keys(context.eventPayload));
  context.db.execute(
    {
      sql: `insert into ${context.event.dataset} (${keys.join(",")}) values (${keys.map(() => "?").join(",")})`,
      parameters: keys.map((key) => context.eventPayload[key]),
    },
    { loggerLevel: "system" },
  );

  const newUpdateLog = Object.fromEntries(keys.map((key) => [key, context.event.timestamp]));
  insertCrdtUpdateLog(context, newUpdateLog);
}

function insertCrdtUpdateLog(context: ApplyCrdtContext, log: Record<string, string>) {
  context.db.executePrepared(
    "insert-crdt-update-log",
    {
      item_id: context.event.item_id,
      dataset: context.event.dataset,
      payload: JSON.stringify(log),
    },
    (db, params) =>
      (db as unknown as Kysely<{ table: CrdtUpdateLogItem }>).insertInto(context.updateLogTableName as "table").values({
        item_id: params("item_id"),
        dataset: params("dataset"),
        payload: params("payload"),
      }),
    { loggerLevel: "system" },
  );
}

function applyItemUpdated(context: ApplyCrdtContext) {
  const meta = context.meta;
  if (!meta) {
    throw new Error(`Item ${context.event.item_id} in dataset ${context.event.dataset} not found`);
  }

  const keys = Array.from(Object.keys(context.eventPayload)).filter((key) => {
    const lastUpdateTimestamp = meta[key];
    if (!lastUpdateTimestamp) {
      return true;
    }

    const currentUpdateTimestamp = context.event.timestamp;
    return currentUpdateTimestamp > lastUpdateTimestamp;
  });

  if (keys.length > 0) {
    context.db.execute(
      {
        sql: `update ${context.event.dataset} set ${keys.map((key) => `${key} = ?`).join(",")} where id = ?`,
        parameters: [...keys.map((key) => context.eventPayload[key]), context.event.item_id],
      },
      { loggerLevel: "system" },
    );

    keys.forEach((key) => {
      meta[key] = context.event.timestamp;
    });
    updateCrdtUpdateLog(context, meta);
  }
}

function updateCrdtUpdateLog(context: ApplyCrdtContext, log: Record<string, string>) {
  context.db.executePrepared(
    "update-crdt-update-log",
    {
      item_id: context.event.item_id,
      dataset: context.event.dataset,
      payload: JSON.stringify(log),
    },
    (db, params) =>
      (db as unknown as Kysely<{ table: CrdtUpdateLogItem }>)
        .updateTable(context.updateLogTableName as "table")
        .set({
          payload: params("payload"),
        })
        .where("item_id", "=", params("item_id"))
        .where("dataset", "=", params("dataset")),
    { loggerLevel: "system" },
  );
}
