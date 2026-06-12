import { describe, expect, expectTypeOf, it } from "vitest";
import { type InferRow, t } from "../src/schema/table-builder";

const item = t.table({
  type: t.text().$type<"movie" | "tv">(),
  tmdbId: t.integer(),
  priority: t.integer().default(0),
  title: t.text().describe("Display title"),
  posterUrl: t.text().nullable(),
  userRating: t.real().nullable(),
  watched: t.boolean().default(false),
  tags: t.text().default("[]"),
  status: t.enum(["idle", "pending", "done"]).default("idle"),
});

describe("column metadata", () => {
  it("records kind, storage type, nullability, and defaults", () => {
    expect(item.columns.title).toEqual({
      kind: "text",
      sqlType: "text",
      nullable: false,
      hasDefault: false,
      description: "Display title",
    });
    expect(item.columns.posterUrl).toMatchObject({ kind: "text", nullable: true, hasDefault: false });
    expect(item.columns.priority).toMatchObject({ kind: "integer", hasDefault: true, defaultValue: 0 });
    expect(item.columns.watched).toMatchObject({ kind: "boolean", sqlType: "integer", defaultValue: false });
    expect(item.columns.status).toMatchObject({
      kind: "enum",
      sqlType: "text",
      enumValues: ["idle", "pending", "done"],
      defaultValue: "idle",
    });
  });

  it("injects id and tombstone columns", () => {
    expect(Object.keys(item.columns)[0]).toBe("id");
    expect(Object.keys(item.columns).at(-1)).toBe("tombstone");
    expect(item.columns.id).toMatchObject({ kind: "text", nullable: false });
    expect(item.columns.tombstone).toMatchObject({ kind: "boolean", hasDefault: true, defaultValue: false });
  });

  it("rejects declaring reserved columns", () => {
    expect(() => t.table({ id: t.text() })).toThrowError(/"id" is added automatically/);
    expect(() => t.table({ tombstone: t.boolean() })).toThrowError(/"tombstone" is added automatically/);
  });

  it("builders are immutable — modifiers return new instances", () => {
    const base = t.text();
    const withDefault = base.default("x");
    expect(base.meta.hasDefault).toBe(false);
    expect(withDefault.meta.hasDefault).toBe(true);
  });

  it("stores the base table name override", () => {
    expect(t.table({ title: t.text() }).baseName).toBeUndefined();
    expect(t.table({ title: t.text() }, { baseName: "raw_item" }).baseName).toBe("raw_item");
  });
});

describe("row type inference", () => {
  it("infers the row shape including auto-injected columns", () => {
    type Row = typeof item.$row;

    expectTypeOf<Row["id"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["type"]>().toEqualTypeOf<"movie" | "tv">();
    expectTypeOf<Row["posterUrl"]>().toEqualTypeOf<string | null>();
    expectTypeOf<Row["watched"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Row["tags"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["status"]>().toEqualTypeOf<"idle" | "pending" | "done">();
    expectTypeOf<Row["tombstone"]>().toEqualTypeOf<boolean | undefined>();

    expectTypeOf<InferRow<typeof item.userColumns>>().toEqualTypeOf<Row>();
  });
});

describe("validatePayload", () => {
  const createdPayload = {
    id: "a1",
    type: "movie",
    tmdbId: 42,
    priority: 1,
    title: "Heat",
    posterUrl: null,
    userRating: 4.5,
    watched: 0,
    tags: '["crime"]',
    tombstone: 0,
  };

  it("accepts a full item-created payload", () => {
    expect(item.validatePayload(createdPayload)).toEqual({ success: true });
  });

  it("allows omitting nullable and defaulted columns on create", () => {
    const { posterUrl, userRating, priority, watched, tags, tombstone, ...required } = createdPayload;
    expect(item.validatePayload(required)).toEqual({ success: true });
  });

  it("reports missing required columns on create", () => {
    const { title, tmdbId, ...partial } = createdPayload;
    const result = item.validatePayload(partial);
    expect(result).toMatchObject({ success: false });
    expect(result.success === false && result.errors).toEqual([
      'Missing required column "tmdbId"',
      'Missing required column "title"',
    ]);
  });

  it("rejects unknown columns", () => {
    const result = item.validatePayload({ ...createdPayload, nope: 1 });
    expect(result.success === false && result.errors).toEqual(['Unknown column "nope"']);
  });

  it("rejects nulls in non-nullable columns", () => {
    const result = item.validatePayload({ ...createdPayload, title: null });
    expect(result.success === false && result.errors).toEqual(['Column "title" is not nullable, got null']);
  });

  it("checks value kinds", () => {
    const result = item.validatePayload({
      ...createdPayload,
      title: 7,
      tmdbId: 1.5,
      userRating: "high",
      watched: "yes",
    });
    expect(result.success === false && result.errors).toEqual([
      'Column "tmdbId" expects an integer, got number',
      'Column "title" expects text, got number',
      'Column "userRating" expects a number, got string',
      'Column "watched" expects a boolean (true/false or 0/1), got string',
    ]);
  });

  it("validates enum membership", () => {
    expect(item.validatePayload({ ...createdPayload, status: "pending" })).toEqual({ success: true });

    const wrongValue = item.validatePayload({ ...createdPayload, status: "paused" });
    expect(wrongValue.success === false && wrongValue.errors).toEqual([
      'Column "status" expects one of "idle" | "pending" | "done", got "paused"',
    ]);

    const wrongType = item.validatePayload({ ...createdPayload, status: 3 });
    expect(wrongType.success === false && wrongType.errors).toEqual([
      'Column "status" expects one of "idle" | "pending" | "done", got number',
    ]);
  });

  it("accepts booleans as true/false or 0/1", () => {
    expect(item.validatePayload({ ...createdPayload, watched: true })).toEqual({ success: true });
    expect(item.validatePayload({ ...createdPayload, watched: 1 })).toEqual({ success: true });
  });

  it("treats item-updated payloads as partial", () => {
    expect(item.validatePayload({ title: "Heat 2" }, { event: "item-updated" })).toEqual({ success: true });
  });

  it("forbids id in item-updated payloads", () => {
    const result = item.validatePayload({ id: "b2", title: "Heat 2" }, { event: "item-updated" });
    expect(result.success === false && result.errors).toEqual([
      'Column "id" is immutable and cannot appear in an update payload',
    ]);
  });
});
