import { createMigrations, defineSyncSchema, t } from "@sqlite-sync/core";
import { describe, expect, it } from "vitest";
import { createSchemaDoc } from "../src/schema-doc";

const migrations = createMigrations(() => ({ 0: [] }));

describe("createSchemaDoc", () => {
  it("renders declared tables under view names with schema descriptions and context overview", () => {
    const syncDbSchema = defineSyncSchema({
      tables: {
        todos: t
          .table({
            title: t.text().describe("Todo title."),
            completed: t.boolean().default(false).describe("1 when done."),
            notes: t.text().nullable(),
          })
          .describe("Todos declared in the schema."),
        tags: t
          .table({
            name: t.text(),
          })
          .describe("Tags declared in the schema."),
      },
      migrations,
    });

    const doc = createSchemaDoc({
      syncDbSchema,
      context: {
        overview: "# Test database\n\nA todo app.",
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
        "Todos declared in the schema.",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL — Unique immutable item id",
        "- `title` TEXT NOT NULL — Todo title.",
        "- `completed` INTEGER NOT NULL (boolean 0/1) — 1 when done.",
        "- `notes` TEXT",
        "",
        "## tags",
        "",
        "Tags declared in the schema.",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL — Unique immutable item id",
        "- `name` TEXT NOT NULL",
      ].join("\n"),
    );
  });

  it("renders the preamble without context and always hides the tombstone column", () => {
    const syncDbSchema = defineSyncSchema({
      tables: {
        tags: t.table({
          name: t.text(),
        }),
      },
      migrations,
    });

    const doc = createSchemaDoc({ syncDbSchema });

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
        "- `id` TEXT NOT NULL — Unique immutable item id",
        "- `name` TEXT NOT NULL",
      ].join("\n"),
    );
    expect(doc).not.toContain("- `tombstone`");
  });

  it("renders enum values and builder descriptions", () => {
    const syncDbSchema = defineSyncSchema({
      tables: {
        items: t.table({
          status: t.enum(["active", "archived"]).describe("Lifecycle state."),
          score: t.real().nullable().describe("Normalized 0..1."),
        }),
      },
      migrations,
    });

    const doc = createSchemaDoc({ syncDbSchema });

    expect(doc).toContain('- `status` TEXT NOT NULL (one of "active" | "archived") — Lifecycle state.');
    expect(doc).toContain("- `score` REAL — Normalized 0..1.");
  });
});
