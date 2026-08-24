import { describe, expect, it } from "vitest";
import { createMigrations } from "../src/migrations/migrator";
import { admitClientEvents } from "../src/schema/admit-client-events";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";

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
  ],
}));

const syncDbSchema = defineSyncSchema({
  tables: {
    todo: t.table({ title: t.text() }),
    job: t.table({ status: t.text() }, { writes: "server" }),
  },
  migrations,
});

function event(dataset: string, item_id: string) {
  return { type: "item-created" as const, dataset, item_id, payload: "{}" };
}

describe("admitClientEvents", () => {
  it("admits client-writable tables and skips server-only ones", () => {
    const todo = event("todo", "t1");
    const job = event("job", "j1");

    expect(admitClientEvents({ syncDbSchema, events: [todo, job] })).toEqual({
      admitted: [todo],
      skipped: [job],
    });
  });

  it("resolves base and crdt table names to the same write origin", () => {
    const result = admitClientEvents({
      syncDbSchema,
      events: [event("_todo", "t1"), event("_job", "j1")],
    });

    expect(result.admitted.map((item) => item.dataset)).toEqual(["_todo"]);
    expect(result.skipped.map((item) => item.dataset)).toEqual(["_job"]);
  });

  it("admits unknown datasets so undeclared tables keep the previous push behavior", () => {
    const unknown = event("scratch", "s1");

    expect(admitClientEvents({ syncDbSchema, events: [unknown] })).toEqual({
      admitted: [unknown],
      skipped: [],
    });
  });

  it("returns an empty enqueue when every event is server-only", () => {
    const job = event("job", "j1");

    expect(admitClientEvents({ syncDbSchema, events: [job] })).toEqual({
      admitted: [],
      skipped: [job],
    });
  });

  it("keeps admitted events in push order", () => {
    const first = event("todo", "t1");
    const skipped = event("job", "j1");
    const second = event("todo", "t2");

    expect(admitClientEvents({ syncDbSchema, events: [first, skipped, second] })).toEqual({
      admitted: [first, second],
      skipped: [skipped],
    });
  });
});
