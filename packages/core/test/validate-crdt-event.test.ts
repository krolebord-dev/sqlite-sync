import { describe, expect, it } from "vitest";
import { createMigrations } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";
import { validateNewCrdtEvent } from "../src/schema/validate-crdt-event";

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_item", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("rating", "real")
        .addColumn("watched", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("kind", "text", (col) => col.notNull().defaultTo("movie"))
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
}));

const schema = defineSyncSchema({
  tables: {
    item: t.table({
      title: t.text(),
      rating: t.real().nullable(),
      watched: t.boolean().default(false),
      kind: t.enum(["movie", "tv"]).default("movie"),
    }),
  },
  migrations,
});

describe("validateNewCrdtEvent", () => {
  it("validates and returns item-created events", () => {
    const event = {
      type: "item-created",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        id: "item-1",
        title: "Heat",
        rating: null,
        watched: false,
        kind: "movie",
      },
    };

    expect(validateNewCrdtEvent(schema, event)).toEqual({ success: true, event });
  });

  it("normalizes crdt table names to base table names", () => {
    const event = {
      type: "item-created",
      dataset: "item",
      item_id: "item-1",
      payload: {
        id: "item-1",
        title: "Heat",
      },
    };

    expect(validateNewCrdtEvent(schema, event)).toEqual({
      success: true,
      event: {
        ...event,
        dataset: "_item",
      },
    });
  });

  it("allows defaulted and nullable columns to be omitted from item-created payloads", () => {
    const event = {
      type: "item-created",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        id: "item-1",
        title: "Heat",
      },
    };

    expect(validateNewCrdtEvent(schema, event)).toEqual({ success: true, event });
  });

  it("returns payload validation errors for invalid creates", () => {
    const result = validateNewCrdtEvent(schema, {
      type: "item-created",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        id: "other",
        watched: "yes",
        kind: "documentary",
      },
    });

    expect(result.success === false && result.errors).toEqual([
      'payload: Missing required column "title"',
      'payload: Column "watched" expects a boolean (true/false or 0/1), got string',
      'payload: Column "kind" expects one of "movie" | "tv", got "documentary"',
      'payload: Column "id" must match item_id "item-1"',
    ]);
  });

  it("validates item-updated events with partial payloads", () => {
    const event = {
      type: "item-updated",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        title: "Heat 2",
      },
    };

    expect(validateNewCrdtEvent(schema, event)).toEqual({ success: true, event });
  });

  it("rejects id and deleted tombstone values in item-updated payloads", () => {
    const result = validateNewCrdtEvent(schema, {
      type: "item-updated",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        id: "item-1",
        tombstone: true,
      },
    });

    expect(result.success === false && result.errors).toEqual([
      'payload: Column "id" is immutable and cannot appear in an update payload',
      'payload: Column "tombstone" cannot be set to true/1 in an update payload; use an item-deleted event',
    ]);
  });

  it("allows non-deleted tombstone values in item-updated payloads", () => {
    const eventWithFalse = {
      type: "item-updated",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        tombstone: false,
      },
    };
    const eventWithZero = {
      type: "item-updated",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        tombstone: 0,
      },
    };

    expect(validateNewCrdtEvent(schema, eventWithFalse)).toEqual({ success: true, event: eventWithFalse });
    expect(validateNewCrdtEvent(schema, eventWithZero)).toEqual({ success: true, event: eventWithZero });
  });

  it("accepts item-deleted events with empty payloads", () => {
    const event = {
      type: "item-deleted",
      dataset: "_item",
      item_id: "item-1",
      payload: {},
    };

    expect(validateNewCrdtEvent(schema, event)).toEqual({ success: true, event });
  });

  it("rejects item-deleted events with payload fields", () => {
    const result = validateNewCrdtEvent(schema, {
      type: "item-deleted",
      dataset: "_item",
      item_id: "item-1",
      payload: {
        tombstone: true,
      },
    });

    expect(result.success === false && result.errors).toEqual([
      "payload: item-deleted events must have an empty payload",
    ]);
  });

  it("returns envelope validation errors for unknown input", () => {
    expect(validateNewCrdtEvent(schema, null)).toEqual({ success: false, errors: ["Event must be an object"] });

    const result = validateNewCrdtEvent(schema, {
      type: "bogus",
      dataset: "_missing",
      item_id: 123,
      payload: [],
    });

    expect(result.success === false && result.errors).toEqual([
      'Invalid event type "bogus"',
      "Event item_id must be a string",
      "Event payload must be an object",
      'Unknown dataset "_missing"',
    ]);
  });
});
