import { createMigrations, defineSyncSchema, t } from "@sqlite-sync/core";
import { describe, expect, it } from "vitest";
import { createSchemaDoc } from "../src/schema-doc";

const migrations = createMigrations(() => ({ 0: [] }));

function declaredTablesDoc(doc: string): string {
  const changeHistoryHeading = "\n\n## change_history";
  expect(doc).toContain(changeHistoryHeading);
  return doc.slice(0, doc.indexOf(changeHistoryHeading));
}

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

    expect(declaredTablesDoc(doc)).toBe(
      [
        "# Test database",
        "",
        "A todo app.",
        "",
        "This is a synced SQLite database. Data replicates automatically between the user's devices.",
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

    expect(declaredTablesDoc(doc)).toBe(
      [
        "This is a synced SQLite database. Data replicates automatically between the user's devices.",
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

  it("documents the change history audit view", () => {
    const syncDbSchema = defineSyncSchema({
      tables: { tags: t.table({ name: t.text() }) },
      migrations,
    });

    const changeHistoryDoc = createSchemaDoc({ syncDbSchema }).split("## change_history\n\n")[1];

    expect(changeHistoryDoc).toBeDefined();
    expect(changeHistoryDoc).toContain("read-only, append-only log");
    expect(changeHistoryDoc).toContain("soft-delete filtering does NOT apply");
    expect(changeHistoryDoc).toContain("order by `seq` instead");
    expect(Array.from(changeHistoryDoc?.matchAll(/^- `([^`]+)`/gm) ?? [], (match) => match[1])).toEqual([
      "seq",
      "dataset",
      "item_id",
      "change_type",
      "status",
      "origin",
      "timestamp",
      "changes",
    ]);
  });

  it("omits hidden tables and labels read-only ones", () => {
    const syncDbSchema = defineSyncSchema({
      tables: {
        todos: t.table({ title: t.text() }),
        audit: t.table({ note: t.text() }, { ai: "read-only", description: "Append-only trail." }),
        billing: t.table({ card: t.text() }, { ai: "hidden" }),
      },
      migrations,
    });

    const doc = createSchemaDoc({ syncDbSchema });

    expect(doc).not.toContain("billing");
    expect(doc).not.toContain("card");
    expect(doc).toContain("- `title` TEXT NOT NULL");
    expect(doc).toContain(
      [
        "## audit",
        "",
        "Append-only trail.",
        "",
        "Read-only: you can query this table but cannot create, update, or delete its rows.",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL — Unique immutable item id",
        "- `note` TEXT NOT NULL",
      ].join("\n"),
    );
  });

  it("drops the change history section and warns about restricted reads once a table is hidden", () => {
    const syncDbSchema = defineSyncSchema({
      tables: {
        todos: t.table({ title: t.text() }),
        billing: t.table({ card: t.text() }, { ai: "hidden" }),
      },
      migrations,
    });

    const doc = createSchemaDoc({ syncDbSchema });

    expect(doc).not.toContain("## change_history");
    expect(doc).toContain("Only the tables documented below are readable.");
  });

  it("keeps the change history when tables are read-only but none are hidden", () => {
    const syncDbSchema = defineSyncSchema({
      tables: {
        todos: t.table({ title: t.text() }, { ai: "read-only" }),
      },
      migrations,
    });

    const doc = createSchemaDoc({ syncDbSchema });

    expect(doc).toContain("Read-only: you can query this table");
    // Nothing is hidden, so reads stay unrestricted and history stays available.
    expect(doc).toContain("## change_history");
    expect(doc).not.toContain("Only the tables documented below are readable.");
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
