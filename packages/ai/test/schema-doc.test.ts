import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";
import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../../core/src/memory-db/sqlite-reactive-db";
import { createSchemaDoc } from "../src/schema-doc";

type TodoRow = {
  id: string;
  title: string;
  completed: number;
  notes: string | null;
};

type TagRow = {
  id: string;
  name: string;
};

const noopLogger = () => {};

async function createTestDb() {
  const reactiveDb = await createSQLiteReactiveDb({
    snapshot: new Uint8Array(),
    logger: noopLogger,
  });
  return reactiveDb.db;
}

describe("createSchemaDoc", () => {
  it("renders introspected tables under view names, merged with context", async () => {
    const db = await createTestDb();
    db.execute(`
      CREATE TABLE "todo" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "completed" INTEGER NOT NULL DEFAULT 0,
        "notes" TEXT,
        "tombstone" INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.execute(`
      CREATE TABLE "tag" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "name" TEXT NOT NULL,
        "tombstone" INTEGER NOT NULL DEFAULT 0
      )
    `);

    const syncDbSchema = createSyncDbSchema({ migrations: createMigrations(() => ({ 0: [] })) })
      .addTable<TodoRow>()
      .withConfig({ baseTableName: "todo", crdtTableName: "todos" })
      .addTable<TagRow>()
      .withConfig({ baseTableName: "tag", crdtTableName: "tags" })
      .build();

    const doc = createSchemaDoc({
      execute: (sql) => db.execute(sql).rows as Record<string, unknown>[],
      syncDbSchema,
      context: {
        overview: "# Test database\n\nA todo app.",
        tables: {
          todos: {
            description: "The user's todos.",
            columns: {
              title: "Todo title.",
              completed: "1 when done.",
            },
          },
        },
      },
    });

    expect(doc).toBe(
      [
        "# Test database",
        "",
        "A todo app.",
        "",
        "This is a synced SQLite database — data replicates automatically between the user's devices.",
        "All writes go through a sync event log, which is why the tables listed below are exposed as",
        "read-only SQL views; soft-deleted rows are already filtered out, so query them directly",
        "without any tombstone filtering. Every table has a unique `id` text primary key.",
        "",
        "## todos",
        "",
        "The user's todos.",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL",
        "- `title` TEXT NOT NULL — Todo title.",
        "- `completed` INTEGER NOT NULL — 1 when done.",
        "- `notes` TEXT",
        "",
        "## tags",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL",
        "- `name` TEXT NOT NULL",
      ].join("\n"),
    );
  });

  it("renders the preamble without context and always hides the tombstone column", async () => {
    const db = await createTestDb();
    db.execute(`
      CREATE TABLE "tag" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tombstone" INTEGER NOT NULL DEFAULT 0
      )
    `);

    const syncDbSchema = createSyncDbSchema({ migrations: createMigrations(() => ({ 0: [] })) })
      .addTable<TagRow>()
      .withConfig({ baseTableName: "tag", crdtTableName: "tags" })
      .build();

    const doc = createSchemaDoc({
      execute: (sql) => db.execute(sql).rows as Record<string, unknown>[],
      syncDbSchema,
    });

    expect(doc).toBe(
      [
        "This is a synced SQLite database — data replicates automatically between the user's devices.",
        "All writes go through a sync event log, which is why the tables listed below are exposed as",
        "read-only SQL views; soft-deleted rows are already filtered out, so query them directly",
        "without any tombstone filtering. Every table has a unique `id` text primary key.",
        "",
        "## tags",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL",
      ].join("\n"),
    );
    expect(doc).not.toContain("- `tombstone`");
  });

  it("quotes base table names when introspecting", async () => {
    const db = await createTestDb();
    db.execute(`
      CREATE TABLE "we""ird table" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "tombstone" INTEGER NOT NULL DEFAULT 0
      )
    `);

    const syncDbSchema = createSyncDbSchema({ migrations: createMigrations(() => ({ 0: [] })) })
      .addTable<TagRow>()
      .withConfig({ baseTableName: 'we"ird table', crdtTableName: "weird" })
      .build();

    const doc = createSchemaDoc({
      execute: (sql) => db.execute(sql).rows as Record<string, unknown>[],
      syncDbSchema,
    });

    expect(doc).toContain(["## weird", "", "Columns:", "- `id` TEXT NOT NULL"].join("\n"));
  });
});
