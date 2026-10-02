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
    const todo = event("_todo", "t1");
    const job = event("_job", "j1");

    expect(admitClientEvents({ syncDbSchema, events: [todo, job] })).toEqual({
      admitted: [todo],
      skipped: [job],
    });
  });

  it("skips crdt view names", () => {
    const events = [event("todo", "t1"), event("job", "j1")];

    expect(admitClientEvents({ syncDbSchema, events })).toEqual({
      admitted: [],
      skipped: events,
    });
  });

  it("skips undeclared datasets, including other spellings of declared tables", () => {
    const events = ["scratch", "JOB", "_Job", "main._job", "TODO", "main.todo", "constructor"].map((dataset) =>
      event(dataset, "x1"),
    );

    expect(admitClientEvents({ syncDbSchema, events })).toEqual({
      admitted: [],
      skipped: events,
    });
  });

  it("keeps admitted events in push order", () => {
    const first = event("_todo", "t1");
    const skipped = event("_job", "j1");
    const second = event("_todo", "t2");

    expect(admitClientEvents({ syncDbSchema, events: [first, skipped, second] })).toEqual({
      admitted: [first, second],
      skipped: [skipped],
    });
  });
});
