import { describe, expect, it } from "vitest";
import { createMigrations } from "../src/migrations/migrator";
import { defineSyncSchema } from "../src/schema/define-sync-schema";
import { t } from "../src/schema/table-builder";
import { formatSchemaVerificationIssues, verifySyncSchema } from "../src/schema/verify-sync-schema";

const baseMigrations = createMigrations((b) => ({
  0: [
    b.createTable("_item", (table) =>
      table
        .addColumn("id", "text", (col) => col.primaryKey().notNull())
        .addColumn("title", "text", (col) => col.notNull())
        .addColumn("rating", "real")
        .addColumn("status", "text", (col) => col.notNull().defaultTo("idle"))
        .addColumn("tags", "text", (col) => col.notNull().defaultTo("[]"))
        .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(false))
        .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
    ),
  ],
  1: [
    b.addColumn({
      table: "_item",
      column: "priority",
      type: "integer",
      defaultValue: 0,
      build: (col) => col.notNull(),
    }),
  ],
}));

const matchingTables = {
  item: t.table({
    title: t.text(),
    rating: t.real().nullable(),
    status: t.enum(["idle", "pending"]).default("idle"),
    tags: t.text().default("[]"),
    completed: t.boolean().default(false),
    priority: t.integer().default(0),
  }),
};

describe("verifySyncSchema", () => {
  it("returns no issues when migrations produce the declared schema", async () => {
    const schema = defineSyncSchema({ tables: matchingTables, migrations: baseMigrations });

    await expect(verifySyncSchema(schema)).resolves.toEqual([]);
  });

  it("reports a declared column missing after migrations", async () => {
    const schema = defineSyncSchema({
      tables: {
        item: t.table({
          ...matchingTables.item.userColumns,
          dueAt: t.integer().nullable(),
        }),
      },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "dueAt", message: expect.stringContaining("missing after migrations") },
    ]);
  });

  it("reports columns created by migrations but not declared", async () => {
    const { priority, ...withoutPriority } = matchingTables.item.userColumns;
    const schema = defineSyncSchema({
      tables: { item: t.table(withoutPriority) },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "priority", message: expect.stringContaining("not declared in the schema") },
    ]);
  });

  it("reports a missing base table", async () => {
    const schema = defineSyncSchema({
      tables: { ...matchingTables, extra: t.table({ name: t.text() }) },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([{ table: "_extra", message: expect.stringContaining("missing after migrations") }]);
  });

  it("ignores extra tables created by migrations", async () => {
    const migrations = createMigrations((b) => ({
      0: [
        b.createTable("_item", (table) =>
          table
            .addColumn("id", "text", (col) => col.primaryKey().notNull())
            .addColumn("title", "text", (col) => col.notNull())
            .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
        ),
        b.createTable("local_cache", (table) => table.addColumn("key", "text", (col) => col.primaryKey())),
      ],
    }));
    const schema = defineSyncSchema({ tables: { item: t.table({ title: t.text() }) }, migrations });

    await expect(verifySyncSchema(schema)).resolves.toEqual([]);
  });

  it("reports type mismatches", async () => {
    const schema = defineSyncSchema({
      tables: {
        item: t.table({ ...matchingTables.item.userColumns, title: t.integer() }),
      },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([{ table: "_item", column: "title", message: expect.stringContaining("type mismatch") }]);
  });

  it("reports nullability mismatches both ways", async () => {
    const schema = defineSyncSchema({
      tables: {
        item: t.table({
          ...matchingTables.item.userColumns,
          title: t.text().nullable(),
          rating: t.real(),
        }),
      },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "title", message: expect.stringContaining("migrated column is NOT NULL") },
      { table: "_item", column: "rating", message: expect.stringContaining("migrated column is nullable") },
    ]);
  });

  it("reports a missing id primary key", async () => {
    const migrations = createMigrations((b) => ({
      0: [
        b.createTable("_item", (table) =>
          table
            .addColumn("id", "text", (col) => col.notNull())
            .addColumn("title", "text", (col) => col.notNull())
            .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
        ),
      ],
    }));
    const schema = defineSyncSchema({ tables: { item: t.table({ title: t.text() }) }, migrations });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([{ table: "_item", column: "id", message: expect.stringContaining("PRIMARY KEY") }]);
  });

  it("reports default presence mismatches both ways", async () => {
    const schema = defineSyncSchema({
      tables: {
        item: t.table({
          ...matchingTables.item.userColumns,
          title: t.text().default("untitled"),
          status: t.enum(["idle", "pending"]),
        }),
      },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "title", message: expect.stringContaining("has no default") },
      { table: "_item", column: "status", message: expect.stringContaining("the schema declares none") },
    ]);
  });

  it("reports default value mismatches", async () => {
    const schema = defineSyncSchema({
      tables: {
        item: t.table({
          ...matchingTables.item.userColumns,
          status: t.enum(["idle", "pending"]).default("pending"),
          completed: t.boolean().default(true),
          priority: t.integer().default(5),
          tags: t.text().default('["inbox"]'),
        }),
      },
      migrations: baseMigrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "status", message: expect.stringContaining("default mismatch") },
      { table: "_item", column: "tags", message: expect.stringContaining("default mismatch") },
      { table: "_item", column: "completed", message: expect.stringContaining("default mismatch") },
      { table: "_item", column: "priority", message: expect.stringContaining("default mismatch") },
    ]);
  });

  it("accepts equivalent default spellings (false vs 0)", async () => {
    const migrations = createMigrations((b) => ({
      0: [
        b.createTable("_item", (table) =>
          table
            .addColumn("id", "text", (col) => col.primaryKey().notNull())
            .addColumn("title", "text", (col) => col.notNull())
            .addColumn("completed", "boolean", (col) => col.notNull().defaultTo(0))
            .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
        ),
      ],
    }));
    const schema = defineSyncSchema({
      tables: { item: t.table({ title: t.text(), completed: t.boolean().default(false) }) },
      migrations,
    });

    await expect(verifySyncSchema(schema)).resolves.toEqual([]);
  });

  it("accepts a declared null default against a migration with no DEFAULT clause", async () => {
    const migrations = createMigrations((b) => ({
      0: [
        b.createTable("_item", (table) =>
          table
            .addColumn("id", "text", (col) => col.primaryKey().notNull())
            .addColumn("title", "text", (col) => col.notNull())
            .addColumn("score", "real")
            .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
        ),
      ],
    }));
    const schema = defineSyncSchema({
      tables: { item: t.table({ title: t.text(), score: t.real().nullable().default(null) }) },
      migrations,
    });

    await expect(verifySyncSchema(schema)).resolves.toEqual([]);
  });

  it("catches a boolean default written as a string literal", async () => {
    const migrations = createMigrations((b) => ({
      0: [
        b.createTable("_item", (table) =>
          table
            .addColumn("id", "text", (col) => col.primaryKey().notNull())
            .addColumn("title", "text", (col) => col.notNull())
            .addColumn("completed", "boolean", (col) => col.notNull().defaultTo("false"))
            .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
        ),
      ],
    }));
    const schema = defineSyncSchema({
      tables: { item: t.table({ title: t.text(), completed: t.boolean().default(false) }) },
      migrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "completed", message: expect.stringContaining("default mismatch") },
    ]);
  });

  it("reports a function-defined default as a mismatch", async () => {
    const migrations = createMigrations((b) => ({
      0: [
        b.createTable("_item", (table) =>
          table
            .addColumn("id", "text", (col) => col.primaryKey().notNull())
            .addColumn("title", "text", (col) => col.notNull())
            .addColumn("tombstone", "boolean", (col) => col.notNull().defaultTo(false)),
        ),
        {
          sql: {
            sql: "ALTER TABLE _item ADD COLUMN createdAt INTEGER NOT NULL DEFAULT (strftime('%s','now'))",
            parameters: [],
          },
        },
      ],
    }));
    const schema = defineSyncSchema({
      tables: { item: t.table({ title: t.text(), createdAt: t.integer().default(0) }) },
      migrations,
    });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([
      { table: "_item", column: "createdAt", message: expect.stringContaining("default mismatch") },
    ]);
  });

  it("reports migration replay failures as an issue", async () => {
    const migrations = createMigrations((b) => ({
      0: [b.addColumn({ table: "_missing", column: "x", type: "text", defaultValue: null })],
    }));
    const schema = defineSyncSchema({ tables: { item: t.table({ title: t.text() }) }, migrations });

    const issues = await verifySyncSchema(schema);
    expect(issues).toEqual([{ table: "(migrations)", message: expect.stringContaining("migration replay failed") }]);
  });
});

describe("formatSchemaVerificationIssues", () => {
  it("formats a readable multi-line report", () => {
    const formatted = formatSchemaVerificationIssues([
      { table: "_item", column: "dueAt", message: "missing" },
      { table: "_extra", message: "missing" },
    ]);

    expect(formatted).toContain("2 issues");
    expect(formatted).toContain('table "_item" column "dueAt": missing');
    expect(formatted).toContain('table "_extra": missing');
  });
});
