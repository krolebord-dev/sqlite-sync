import { createMigrations, defineSyncSchema, SQLiteReactiveDb, t } from "@sqlite-sync/core";
import { beforeAll, describe, expect, it } from "vitest";
import { type AiDbExecutor, createAiDbAccess } from "../src/db-access";

function createFakeExecutor() {
  const calls: string[] = [];

  const executor: AiDbExecutor = {
    execute: <TResult>(query: { sql: string; parameters: readonly unknown[] }) => {
      calls.push(query.sql);
      return { rows: [] as TResult[] };
    },
    transaction: (callback) => callback(executor),
  };

  return { executor, calls };
}

const syncDbSchema = defineSyncSchema({
  tables: {
    items: t.table({ title: t.text() }, { baseName: "item" }).describe("The user's items."),
  },
  migrations: createMigrations(() => ({ 0: [] })),
});

describe("createAiDbAccess", () => {
  it("builds the schema doc from the declared schema without touching the database", () => {
    const { executor, calls } = createFakeExecutor();
    const access = createAiDbAccess({
      executor,
      syncDbSchema,
    });

    const doc = access.getSchemaDoc();

    expect(calls).toEqual([]);
    expect(access.getSchemaDoc()).toBe(doc);
    expect(doc).toContain("read-only SQL views");
    expect(doc).toContain(
      [
        "## items",
        "",
        "The user's items.",
        "",
        "Columns:",
        "- `id` TEXT NOT NULL — Unique immutable item id",
        "- `title` TEXT NOT NULL",
      ].join("\n"),
    );
  });
});

// Real wasm SQLite — query goes through the guard's EXPLAIN analysis and forced rollback.
describe("createAiDbAccess query", () => {
  let executor: AiDbExecutor;

  beforeAll(async () => {
    const reactiveDb = await SQLiteReactiveDb.create<Record<string, never>>({
      snapshot: new Uint8Array(),
      logger: () => {},
    });
    const db = reactiveDb.db;

    db.execute(`CREATE TABLE "item" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL)`);
    db.execute(`INSERT INTO "item" ("id", "title") VALUES ('1', 'first'), ('2', 'second'), ('3', 'a longer title')`);

    executor = {
      execute: <TResult>(query: { sql: string; parameters: readonly unknown[] }) =>
        db.execute<TResult>({ sql: query.sql, parameters: query.parameters as unknown[] }),
      transaction: (callback) => db.executeTransaction(() => callback(executor)),
    };
  });

  it("returns result records", () => {
    const access = createAiDbAccess({ executor, syncDbSchema });

    const result = access.query({ sql: "SELECT id, title FROM item WHERE id = ?", parameters: ["1"] });

    expect(result).toEqual({
      rows: [{ id: "1", title: "first" }],
      rowCount: 1,
      truncated: false,
    });
  });

  it("returns an empty shape for empty results", () => {
    const access = createAiDbAccess({ executor, syncDbSchema });

    expect(access.query({ sql: "SELECT id FROM item WHERE id = 'nope'" })).toEqual({
      rows: [],
      rowCount: 0,
      truncated: false,
    });
  });

  it("caps rows and clips long cells per limits, reporting truncation", () => {
    const access = createAiDbAccess({ executor, syncDbSchema, limits: { maxRows: 2, maxCellChars: 8 } });

    const result = access.query({ sql: "SELECT id, title FROM item ORDER BY id" });

    expect(result).toEqual({
      rows: [
        { id: "1", title: "first" },
        { id: "2", title: "second" },
      ],
      rowCount: 3,
      truncated: true,
    });

    const clipped = access.query({ sql: "SELECT title FROM item WHERE id = '3'" });
    expect(clipped).toEqual({
      rows: [{ title: "a longer…" }],
      rowCount: 1,
      truncated: true,
    });
  });

  it("returns small blobs as base64 and oversized blobs as a placeholder with truncation", () => {
    executor.execute({
      sql: `CREATE TABLE "attachment" ("id" TEXT PRIMARY KEY, "data" BLOB NOT NULL)`,
      parameters: [],
    });
    executor.execute({
      sql: `INSERT INTO "attachment" ("id", "data") VALUES ('small', X'010203'), ('big', X'01020304050607')`,
      parameters: [],
    });

    // maxCellChars 8 fits base64 of up to 6 bytes: 3 bytes -> "AQID", 7 bytes -> placeholder.
    const access = createAiDbAccess({ executor, syncDbSchema, limits: { maxCellChars: 8 } });

    expect(access.query({ sql: "SELECT data FROM attachment WHERE id = 'small'" })).toEqual({
      rows: [{ data: "<blob base64 AQID>" }],
      rowCount: 1,
      truncated: false,
    });
    expect(access.query({ sql: "SELECT data FROM attachment WHERE id = 'big'" })).toEqual({
      rows: [{ data: "<blob 7 bytes>" }],
      rowCount: 1,
      truncated: true,
    });
  });

  it("returns guard rejections as model-facing errors instead of throwing", () => {
    const access = createAiDbAccess({ executor, syncDbSchema });

    const rejected = access.query({ sql: "DELETE FROM item" });
    expect(rejected).toHaveProperty("error");
    if ("error" in rejected) {
      expect(rejected.error).toContain("read-only");
    }

    expect(executor.execute({ sql: "SELECT count(*) AS count FROM item", parameters: [] }).rows).toEqual([
      { count: 3 },
    ]);
  });
});
