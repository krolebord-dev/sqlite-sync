import {
  CrdtEventValidationError,
  createMigrations,
  defineSyncSchema,
  type OwnCrdtEvent,
  SQLiteReactiveDb,
  t,
} from "@sqlite-sync/core";
import { beforeAll, describe, expect, it } from "vitest";
import { type AiDbAccess, type AiDbExecutor, createAiDbAccess } from "../src/db-access";

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

  it("exposes mutate when storage is provided and applies CRDT own events with generated create ids", () => {
    const { executor } = createFakeExecutor();
    const applied: OwnCrdtEvent[] = [];
    const access = createAiDbAccess({
      executor,
      storage: {
        applyOwnEvents: (events) => {
          applied.push(...events);
        },
      },
      syncDbSchema,
    });

    expect(access.mutate).toBeTypeOf("function");
    const result = access.mutate?.({
      events: [{ type: "item-created", dataset: "item", payload: { title: "first" } }],
    });

    expect(result).toEqual({ applied: true, eventCount: 1, createdIds: [expect.any(String)] });
    if (!result || "error" in result) {
      throw new Error("mutation should have succeeded");
    }
    expect(applied).toHaveLength(1);
    expect(applied[0]?.type).toBe("item-created");
    expect(applied[0]?.dataset).toBe("item");
    expect(applied[0]?.item_id).toBe(result.createdIds[0]);
    expect(JSON.parse(applied[0]?.payload ?? "{}")).toEqual({ id: result.createdIds[0], title: "first" });
  });

  it("rejects create events when the caller provides an id", () => {
    const { executor } = createFakeExecutor();
    const applied: unknown[] = [];
    const access = createAiDbAccess({
      executor,
      storage: {
        applyOwnEvents: (events) => {
          applied.push(...events);
        },
      },
      syncDbSchema,
    });

    expect(
      access.mutate?.({
        events: [
          { type: "item-created", dataset: "item", item_id: "1", payload: { title: "first" } },
          { type: "item-created", dataset: "item", payload: { id: "2", title: "second" } },
        ],
      } as unknown as Parameters<NonNullable<typeof access.mutate>>[0]),
    ).toEqual({
      error:
        "Invalid mutation events: [0] item-created events must omit item_id; an id is generated automatically; [1] item-created payload must omit id; an id is generated automatically",
      errors: [
        "[0] item-created events must omit item_id; an id is generated automatically",
        "[1] item-created payload must omit id; an id is generated automatically",
      ],
    });
    expect(applied).toEqual([]);
  });

  it("returns validation errors from CRDT storage as mutation results", () => {
    const { executor } = createFakeExecutor();
    const access = createAiDbAccess({
      executor,
      storage: {
        applyOwnEvents: () => {
          throw new CrdtEventValidationError(['[0] payload: Unknown column "nope"']);
        },
      },
      syncDbSchema,
    });

    expect(
      access.mutate?.({ events: [{ type: "item-updated", dataset: "item", item_id: "1", payload: { nope: 1 } }] }),
    ).toEqual({
      error: 'Invalid CRDT events: [0] payload: Unknown column "nope"',
      errors: ['[0] payload: Unknown column "nope"'],
    });
  });

  it("rejects mutations to datasets outside the schema before reaching storage", () => {
    const { executor } = createFakeExecutor();
    const applied: unknown[] = [];
    const access = createAiDbAccess({
      executor,
      storage: { applyOwnEvents: (events) => applied.push(...events) },
      syncDbSchema,
    });

    expect(access.mutate?.({ events: [{ type: "item-deleted", dataset: "missing", item_id: "1" }] })).toEqual({
      error: 'Invalid mutation events: [0] unknown or unavailable dataset "missing"',
      errors: ['[0] unknown or unavailable dataset "missing"'],
    });
    expect(applied).toEqual([]);
  });
});

describe("createAiDbAccess policy enforcement", () => {
  const policySchema = defineSyncSchema({
    tables: {
      items: t.table({ title: t.text() }, { baseName: "item" }),
      audit: t.table({ note: t.text() }, { ai: "read-only" }),
      billing: t.table({ card: t.text() }, { ai: "hidden" }),
    },
    migrations: createMigrations(() => ({ 0: [] })),
  });

  function createAccess() {
    const { executor } = createFakeExecutor();
    const applied: OwnCrdtEvent[] = [];
    const access = createAiDbAccess({
      executor,
      storage: { applyOwnEvents: (events) => applied.push(...events) },
      syncDbSchema: policySchema,
    });
    return { access, applied };
  }

  it("rejects mutations to read-only and hidden tables", () => {
    const { access, applied } = createAccess();

    expect(access.mutate?.({ events: [{ type: "item-created", dataset: "audit", payload: { note: "x" } }] })).toEqual({
      error: 'Invalid mutation events: [0] dataset "audit" is read-only and cannot be modified',
      errors: ['[0] dataset "audit" is read-only and cannot be modified'],
    });
    expect(access.mutate?.({ events: [{ type: "item-deleted", dataset: "billing", item_id: "1" }] })).toEqual({
      error: 'Invalid mutation events: [0] unknown or unavailable dataset "billing"',
      errors: ['[0] unknown or unavailable dataset "billing"'],
    });
    expect(applied).toEqual([]);
  });

  it("still applies mutations to read-write tables", () => {
    const { access, applied } = createAccess();

    expect(
      access.mutate?.({ events: [{ type: "item-updated", dataset: "item", item_id: "1", payload: { title: "ok" } }] }),
    ).toEqual({ applied: true, eventCount: 1, createdIds: [] });
    expect(applied).toHaveLength(1);
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

  it("keeps reads unrestricted while no table is hidden", () => {
    const access = createAiDbAccess({ executor, syncDbSchema });

    expect(access.query({ sql: "SELECT count(*) AS count FROM sqlite_master" })).toMatchObject({ truncated: false });
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

// A hidden table turns reads into an allow-list of the remaining base tables, enforced end to end.
describe("createAiDbAccess query with a hidden table", () => {
  const restrictedSchema = defineSyncSchema({
    tables: {
      items: t.table({ title: t.text() }, { baseName: "item" }),
      billing: t.table({ card: t.text() }, { ai: "hidden" }),
    },
    migrations: createMigrations(() => ({ 0: [] })),
  });

  let access: AiDbAccess;

  beforeAll(async () => {
    const reactiveDb = await SQLiteReactiveDb.create<Record<string, never>>({
      snapshot: new Uint8Array(),
      logger: () => {},
    });
    const db = reactiveDb.db;

    db.execute(`CREATE TABLE "item" ("id" TEXT PRIMARY KEY, "title" TEXT NOT NULL, "tombstone" INTEGER DEFAULT 0)`);
    db.execute(`CREATE VIEW "items" AS SELECT "id", "title" FROM "item" WHERE "tombstone" = 0`);
    db.execute(`CREATE TABLE "_billing" ("id" TEXT PRIMARY KEY, "card" TEXT NOT NULL, "tombstone" INTEGER DEFAULT 0)`);
    db.execute(`CREATE VIEW "billing" AS SELECT "id", "card" FROM "_billing" WHERE "tombstone" = 0`);
    db.execute(`CREATE TABLE "crdt_events" ("sync_id" INTEGER PRIMARY KEY, "dataset" TEXT, "payload" TEXT)`);
    db.execute(`INSERT INTO "item" ("id", "title") VALUES ('1', 'first')`);
    db.execute(`INSERT INTO "_billing" ("id", "card") VALUES ('1', '4111')`);
    db.execute(`INSERT INTO "crdt_events" VALUES (1, 'billing', '{"card":"4111"}')`);

    const executor: AiDbExecutor = {
      execute: <TResult>(query: { sql: string; parameters: readonly unknown[] }) =>
        db.execute<TResult>({ sql: query.sql, parameters: query.parameters as unknown[] }),
      transaction: (callback) => db.executeTransaction(() => callback(executor)),
    };

    access = createAiDbAccess({ executor, syncDbSchema: restrictedSchema });
  });

  it("still reads the visible table", () => {
    expect(access.query({ sql: "SELECT title FROM items" })).toEqual({
      rows: [{ title: "first" }],
      rowCount: 1,
      truncated: false,
    });
  });

  it("rejects reads of the hidden table and of the event log that carries its payloads", () => {
    for (const sql of [
      "SELECT card FROM billing",
      `SELECT card FROM "_billing"`,
      "SELECT (SELECT card FROM billing LIMIT 1) AS leak FROM items",
      "SELECT payload FROM crdt_events",
    ]) {
      const result = access.query({ sql });
      expect(result).toHaveProperty("error");
      if ("error" in result) {
        expect(result.error).toContain("not available to you");
      }
    }
  });
});
