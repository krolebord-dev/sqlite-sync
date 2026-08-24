import type { ColumnType } from "kysely";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createMigrations } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";

const migrations = createMigrations((b) => ({
  0: [
    b.createTable("_todo", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
}));

const tables = {
  todo: t.table({
    title: t.text(),
    completed: t.boolean().default(false),
  }),
};

describe("defineSyncSchema", () => {
  it("derives base table names with the underscore convention", () => {
    const schema = defineSyncSchema({ tables, migrations });

    expect(schema.tablesConfig).toEqual([{ crdtTableName: "todo", baseTableName: "_todo" }]);
  });

  it("respects per-table baseName overrides", () => {
    const schema = defineSyncSchema({
      tables: { todo: t.table({ title: t.text() }, { baseName: "raw_todo" }) },
      migrations,
    });

    expect(schema.tablesConfig).toEqual([{ crdtTableName: "todo", baseTableName: "raw_todo" }]);
  });

  it("passes migrations through unchanged", () => {
    const schema = defineSyncSchema({ tables, migrations });

    expect(schema.migrations).toBe(migrations);
  });

  it("exposes the table builders for metadata access", () => {
    const schema = defineSyncSchema({ tables, migrations });

    expect(schema.tables.todo.columns.title).toMatchObject({ kind: "text" });
    expect(schema.tables.todo.validatePayload({ title: "x" }, { event: "item-updated" })).toEqual({ success: true });
  });

  it("indexes write origin by crdt and base table name", () => {
    const schema = defineSyncSchema({
      tables: {
        todo: t.table({ title: t.text() }),
        job: t.table({ status: t.text() }, { writes: "server" }),
      },
      migrations,
    });

    expect(schema.writeOriginByName.get("todo")).toBe("any");
    expect(schema.writeOriginByName.get("_todo")).toBe("any");
    expect(schema.writeOriginByName.get("job")).toBe("server");
    expect(schema.writeOriginByName.get("_job")).toBe("server");
  });

  it("rejects colliding table names", () => {
    expect(() =>
      defineSyncSchema({
        tables: {
          todo: t.table({ title: t.text() }),
          other: t.table({ title: t.text() }, { baseName: "todo" }),
        },
        migrations,
      }),
    ).toThrowError('Duplicate table name "todo"');
  });

  it("rejects colliding table names with different casing", () => {
    expect(() =>
      defineSyncSchema({
        tables: {
          todo: t.table({ title: t.text() }),
          other: t.table({ title: t.text() }, { baseName: "TODO" }),
        },
        migrations,
      }),
    ).toThrowError('Duplicate table name "TODO"');
  });

  it("reserves the CRDT change-intent table name", () => {
    expect(() =>
      defineSyncSchema({
        tables: { crdt_change_intents: t.table({ title: t.text() }) },
        migrations,
      }),
    ).toThrowError('Table name "crdt_change_intents" is reserved by sqlite-sync');
  });

  it("reserves the CRDT change-intent table name with different casing", () => {
    expect(() =>
      defineSyncSchema({
        tables: { CRDT_CHANGE_INTENTS: t.table({ title: t.text() }) },
        migrations,
      }),
    ).toThrowError('Table name "CRDT_CHANGE_INTENTS" is reserved by sqlite-sync');
  });

  it("throws when type-only schemas are accessed at runtime", () => {
    const schema = defineSyncSchema({ tables, migrations });

    expect(() => schema["~clientSchema"]).toThrowError("~clientSchema is type-only");
    expect(() => schema["~serverSchema"]).toThrowError("~serverSchema is type-only");
    expect(() => schema["~mutationsSchema"]).toThrowError("~mutationsSchema is type-only");
  });
});

describe("schema type inference", () => {
  const schema = defineSyncSchema({ tables, migrations });

  type Client = (typeof schema)["~clientSchema"];
  type Server = (typeof schema)["~serverSchema"];
  type Mutations = (typeof schema)["~mutationsSchema"];

  it("client schema has a writable crdt table and a readonly base table", () => {
    expectTypeOf<keyof Client>().toEqualTypeOf<"todo" | "_todo">();
    expectTypeOf<Client["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Client["todo"]["completed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<Client["todo"]["tombstone"]>().toEqualTypeOf<boolean | undefined>();
    expectTypeOf<Client["_todo"]["title"]>().toEqualTypeOf<ColumnType<string, never, never>>();
  });

  it("server schema has a writable crdt table and a readonly base table", () => {
    expectTypeOf<keyof Server>().toEqualTypeOf<"todo" | "_todo">();
    expectTypeOf<Server["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Server["_todo"]["title"]>().toEqualTypeOf<ColumnType<string, never, never>>();
  });

  it("mutations schema exposes writable base tables only", () => {
    expectTypeOf<keyof Mutations>().toEqualTypeOf<"_todo">();
    expectTypeOf<Mutations["_todo"]["title"]>().toEqualTypeOf<string>();
  });

  it("keys stay literal for tables declared inline (no widening to an index signature)", () => {
    const inline = defineSyncSchema({
      tables: { todo: t.table({ title: t.text() }) },
      migrations,
    });

    expectTypeOf<keyof (typeof inline)["~clientSchema"]>().toEqualTypeOf<"todo" | "_todo">();
  });

  it("baseName override stays literal when declared inline", () => {
    const inline = defineSyncSchema({
      tables: { todo: t.table({ title: t.text() }, { baseName: "raw_todo" }) },
      migrations,
    });

    expectTypeOf<keyof (typeof inline)["~clientSchema"]>().toEqualTypeOf<"todo" | "raw_todo">();
  });

  it("baseName override flows into the schema types", () => {
    const overridden = defineSyncSchema({
      tables: { todo: t.table({ title: t.text() }, { baseName: "raw_todo" }) },
      migrations,
    });

    type OverriddenClient = (typeof overridden)["~clientSchema"];
    expectTypeOf<keyof OverriddenClient>().toEqualTypeOf<"todo" | "raw_todo">();
  });
});

describe("write origin schema split", () => {
  const schema = defineSyncSchema({
    tables: {
      todo: t.table({ title: t.text() }),
      job: t.table({ status: t.text() }, { writes: "server" }),
      queued: t.table({ status: t.text() }).writes("server"),
    },
    migrations,
  });

  type Client = (typeof schema)["~clientSchema"];
  type Server = (typeof schema)["~serverSchema"];
  type Mutations = (typeof schema)["~mutationsSchema"];

  it("client schema makes server-only crdt views readonly", () => {
    expectTypeOf<Client["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Client["job"]["status"]>().toEqualTypeOf<ColumnType<string, never, never>>();
    expectTypeOf<Client["queued"]["status"]>().toEqualTypeOf<ColumnType<string, never, never>>();
    expectTypeOf<Client["_job"]["status"]>().toEqualTypeOf<ColumnType<string, never, never>>();
    expectTypeOf<Client["_queued"]["status"]>().toEqualTypeOf<ColumnType<string, never, never>>();
  });

  it("server schema keeps every crdt view writable, including server-only tables", () => {
    expectTypeOf<Server["todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Server["job"]["status"]>().toEqualTypeOf<string>();
    expectTypeOf<Server["queued"]["status"]>().toEqualTypeOf<string>();
    expectTypeOf<Server["_job"]["status"]>().toEqualTypeOf<ColumnType<string, never, never>>();
    expectTypeOf<Server["_queued"]["status"]>().toEqualTypeOf<ColumnType<string, never, never>>();
  });

  it("mutations schema keeps server-only base tables writable", () => {
    expectTypeOf<keyof Mutations>().toEqualTypeOf<"_todo" | "_job" | "_queued">();
    expectTypeOf<Mutations["_todo"]["title"]>().toEqualTypeOf<string>();
    expectTypeOf<Mutations["_job"]["status"]>().toEqualTypeOf<string>();
    expectTypeOf<Mutations["_queued"]["status"]>().toEqualTypeOf<string>();
  });
});
