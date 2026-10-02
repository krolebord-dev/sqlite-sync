import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_DRIFT_MS, serializeHLC } from "../src/hlc";
import { createMigrations, createMigrator } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";
import { admitClientPush, type PushedCrdtEvent } from "../src/server/admit-client-push";
import { CRDT_EVENT_NO_OP_PAYLOAD } from "../src/sqlite-crdt/crdt-table-schema";

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_todo", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
    b.createTable("_job", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("status", "text", (col) => col.notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
    b.createTable("_label", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("text", "text", (col) => col.notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
    b.createTable("_legacy", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
  1: [
    b.renameTable({ oldTable: "_label", newTable: "_tag" }),
    b.renameColumn({ table: "_tag", oldColumn: "text", newColumn: "name" }),
    b.dropTable("_legacy"),
    {
      sql: [],
      eventTransformer: {
        _todo: (event) => {
          if (event.payload.title === "boom") {
            throw new Error("boom");
          }
          return event;
        },
      },
    },
  ],
}));

const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t.table({ title: t.text() }),
    job: t.table({ status: t.text() }, { writes: "server" }),
    tag: t.table({ name: t.text() }),
  },
  migrations,
});

const migrator = createMigrator({
  migrations,
  schemaVersion: { current: 1 },
  updateLogTableName: "crdt_update_log",
});

const now = 1_800_000_000_000;

function pushed(overrides: Partial<PushedCrdtEvent> = {}): PushedCrdtEvent {
  return {
    schema_version: 1,
    timestamp: serializeHLC({ timestamp: now, counter: 0, nodeId: "client" }),
    type: "item-created",
    dataset: "_todo",
    item_id: "t1",
    payload: JSON.stringify({ id: "t1", title: "Buy milk" }),
    ...overrides,
  };
}

function admit(events: PushedCrdtEvent[]) {
  return admitClientPush({ syncDbSchema, migrator, events, now });
}

function rejectionReasons(events: PushedCrdtEvent[]) {
  return admit(events).rejected.map((rejection) => rejection.reason);
}

describe("admitClientPush", () => {
  it("admits valid current-version events unchanged", () => {
    const create = pushed();
    const update = pushed({ type: "item-updated", payload: JSON.stringify({ title: "Buy oat milk" }) });
    const remove = pushed({ type: "item-deleted", payload: "{}" });

    expect(admit([create, update, remove])).toEqual({ admitted: [create, update, remove], rejected: [] });
  });

  it("rejects non-canonical timestamps", () => {
    const timestamps = [
      "9:0:client",
      "1800000000000:00000:client",
      "001800000000000:0000Z:client",
      "001800000000000:00000:",
      "001800000000000:00000",
    ];

    expect(rejectionReasons(timestamps.map((timestamp) => pushed({ timestamp })))).toEqual(
      timestamps.map(() => "invalid-timestamp"),
    );
  });

  it("accepts timestamps up to the drift limit and rejects later ones", () => {
    const atLimit = pushed({
      timestamp: serializeHLC({ timestamp: now + DEFAULT_MAX_DRIFT_MS, counter: 0, nodeId: "client" }),
    });
    const pastLimit = pushed({
      timestamp: serializeHLC({ timestamp: now + DEFAULT_MAX_DRIFT_MS + 1, counter: 0, nodeId: "client" }),
    });

    const result = admit([atLimit, pastLimit]);

    expect(result.admitted).toEqual([atLimit]);
    expect(result.rejected).toEqual([{ event: pastLimit, reason: "timestamp-too-far-in-future" }]);
  });

  it("rejects invalid and too-new schema versions", () => {
    expect(
      rejectionReasons([
        pushed({ schema_version: -1 }),
        pushed({ schema_version: 0.5 }),
        pushed({ schema_version: 2 }),
      ]),
    ).toEqual(["invalid-schema-version", "invalid-schema-version", "schema-version-too-new"]);
  });

  it("rejects payloads that are not JSON objects", () => {
    const payloads = ["not json", "null", "[]", "5", '"text"'];

    expect(rejectionReasons(payloads.map((payload) => pushed({ payload })))).toEqual(
      payloads.map(() => "invalid-payload"),
    );
  });

  it("migrates old-version events before checking them against the current schema", () => {
    const event = pushed({
      schema_version: 0,
      dataset: "_label",
      item_id: "l1",
      payload: JSON.stringify({ id: "l1", text: "urgent" }),
    });

    expect(admit([event])).toEqual({
      admitted: [
        {
          ...event,
          schema_version: 1,
          dataset: "_tag",
          payload: JSON.stringify({ id: "l1", name: "urgent" }),
        },
      ],
      rejected: [],
    });
    expect(event.dataset).toBe("_label");
  });

  it("turns events for dropped tables into no-ops", () => {
    const event = pushed({
      schema_version: 0,
      dataset: "_legacy",
      item_id: "x1",
      payload: JSON.stringify({ id: "x1" }),
    });

    expect(admit([event])).toEqual({
      admitted: [{ ...event, schema_version: 1, payload: CRDT_EVENT_NO_OP_PAYLOAD }],
      rejected: [],
    });
  });

  it("rejects events whose migration throws", () => {
    const event = pushed({ schema_version: 0, payload: JSON.stringify({ id: "t1", title: "boom" }) });

    expect(admit([event])).toEqual({
      admitted: [],
      rejected: [{ event, reason: "migration-failed", errors: ["boom"] }],
    });
  });

  it("admits no-op events without migrating or checking their dataset", () => {
    const event = pushed({ schema_version: 0, dataset: "_legacy", payload: CRDT_EVENT_NO_OP_PAYLOAD });

    expect(admit([event])).toEqual({ admitted: [event], rejected: [] });
  });

  it("rejects server-only, crdt view, and undeclared datasets", () => {
    expect(
      rejectionReasons([
        pushed({ dataset: "_job", payload: JSON.stringify({ id: "t1", status: "done" }) }),
        pushed({ dataset: "todo" }),
        pushed({ dataset: "_TODO" }),
        pushed({ dataset: "main._todo" }),
      ]),
    ).toEqual(["server-only-dataset", "undeclared-dataset", "undeclared-dataset", "undeclared-dataset"]);
  });

  it("rejects payloads that do not match the schema", () => {
    const wrongType = pushed({ payload: JSON.stringify({ id: "t1", title: 12345 }) });
    const idMismatch = pushed({ payload: JSON.stringify({ id: "other", title: "Buy milk" }) });
    const prototypeKey = pushed({ payload: JSON.stringify({ id: "t1", title: "Buy milk", constructor: "x" }) });

    expect(admit([wrongType, idMismatch, prototypeKey]).rejected).toEqual([
      {
        event: wrongType,
        reason: "schema-validation-failed",
        errors: ['payload: Column "title" expects text, got number'],
      },
      {
        event: idMismatch,
        reason: "schema-validation-failed",
        errors: ['payload: Column "id" must match item_id "t1"'],
      },
      { event: prototypeKey, reason: "schema-validation-failed", errors: ['payload: Unknown column "constructor"'] },
    ]);
  });

  it("keeps admitted events in push order around rejected ones", () => {
    const first = pushed({ item_id: "t1" });
    const rejected = pushed({ item_id: "t2", timestamp: "bad" });
    const second = pushed({ item_id: "t3", payload: JSON.stringify({ id: "t3", title: "Walk dog" }) });

    expect(admit([first, rejected, second])).toEqual({
      admitted: [first, second],
      rejected: [{ event: rejected, reason: "invalid-timestamp" }],
    });
  });
});
