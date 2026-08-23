import { SQLiteReactiveDb } from "@sqlite-sync/core";
import { beforeAll, describe, expect, it } from "vitest";
import type { AiDbExecutor } from "../src/db-access";
import { createQueryGuard, type QueryGuard, QueryGuardError, runWithForcedRollback } from "../src/query-guard";

const noopLogger = () => {};

let executor: AiDbExecutor;
let guard: QueryGuard;
let countItems: () => number;

// Real wasm SQLite so EXPLAIN bytecode analysis is exercised for real. The schema mirrors
// what the DO adapter produces: base tables with a tombstone column, read-only views named
// after the CRDT tables, plus internal tables (readable — the guard only blocks writes).
beforeAll(async () => {
  const reactiveDb = await SQLiteReactiveDb.create<Record<string, never>>({
    snapshot: new Uint8Array(),
    logger: noopLogger,
  });
  const db = reactiveDb.db;

  db.execute(`
    CREATE TABLE "item" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "title" TEXT NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.execute(`CREATE INDEX "item_title_idx" ON "item" ("title")`);
  db.execute(`CREATE VIEW "items" AS SELECT * FROM "item" WHERE "tombstone" = 0`);
  db.execute(`
    CREATE TABLE "persisted_crdt_events" (
      "sync_id" INTEGER PRIMARY KEY,
      "payload" TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE "secret" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "token" TEXT NOT NULL,
      "tombstone" INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.execute(`CREATE INDEX "secret_token_idx" ON "secret" ("token")`);
  db.execute(`CREATE VIEW "secrets" AS SELECT * FROM "secret" WHERE "tombstone" = 0`);

  db.execute(`INSERT INTO "item" ("id", "title", "tombstone") VALUES ('1', 'first', 0), ('2', 'gone', 1)`);
  db.execute(`INSERT INTO "secret" ("id", "token") VALUES ('1', 'hunter2')`);
  db.execute(`INSERT INTO "persisted_crdt_events" ("sync_id", "payload") VALUES (1, 'secret')`);

  executor = {
    execute: <TResult>(query: { sql: string; parameters: readonly unknown[] }) =>
      db.execute<TResult>({ sql: query.sql, parameters: query.parameters as unknown[] }),
    transaction: (callback) => db.executeTransaction(() => callback(executor)),
  };

  guard = createQueryGuard({ executor });

  countItems = () =>
    executor.execute<{ count: number }>({ sql: `SELECT count(*) AS count FROM "item"`, parameters: [] }).rows[0]
      ?.count ?? -1;
});

function expectRejection(sql: string, code: string, parameters: readonly unknown[] = []) {
  const verdict = guard.check({ sql, parameters });
  expect(verdict.allowed).toBe(false);
  if (!verdict.allowed) {
    expect(verdict.code).toBe(code);
  }
  return verdict as { allowed: false; code: string; message: string };
}

describe("createQueryGuard", () => {
  it("allows a select on the view and filters tombstoned rows", () => {
    expect(guard.check({ sql: "SELECT id, title FROM items" })).toEqual({ allowed: true });

    const { rows } = guard.execute<{ id: string; title: string }>({ sql: "SELECT id, title FROM items" });
    expect(rows).toEqual([{ id: "1", title: "first" }]);
  });

  it("allows parameterized queries (EXPLAIN works with bindings)", () => {
    const { rows } = guard.execute<{ id: string }>({
      sql: "SELECT id FROM items WHERE title = ?",
      parameters: ["first"],
    });
    expect(rows).toEqual([{ id: "1" }]);
  });

  it("allows index-backed reads (index root pages resolve to their table)", () => {
    const verdict = guard.check({
      sql: `SELECT * FROM "item" INDEXED BY "item_title_idx" WHERE title = ?`,
      parameters: ["first"],
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it("allows trailing semicolons and case-insensitive table names", () => {
    expect(guard.check({ sql: "SELECT * FROM ITEMS ; ;" })).toEqual({ allowed: true });
  });

  it("allows comments after the first keyword", () => {
    expect(guard.check({ sql: "SELECT * FROM items /* comment */ -- trailing" })).toEqual({ allowed: true });
  });

  it("conservatively rejects semicolons inside string literals (values belong in parameters)", () => {
    const verdict = expectRejection("SELECT * FROM items WHERE title = 'a;b'", "multi-statement");
    expect(verdict.message).toContain("parameter");
  });

  it("conservatively rejects leading comments", () => {
    expectRejection("-- leading comment\nSELECT * FROM items", "invalid-statement");
  });

  it("allows queries with no table access at all", () => {
    expect(guard.check({ sql: "SELECT 1 + 1" })).toEqual({ allowed: true });
    expect(guard.check({ sql: "VALUES (1), (2)" })).toEqual({ allowed: true });
  });

  it("allows read-only virtual tables like json_each", () => {
    const { rows } = guard.execute<{ value: number }>({ sql: "SELECT value FROM json_each('[1,2,3]')" });
    expect(rows).toHaveLength(3);
  });

  it("rejects non-select statements at the keyword gate", () => {
    expectRejection("UPDATE item SET title = 'x'", "invalid-statement");
    expectRejection("DELETE FROM item", "invalid-statement");
    expectRejection("PRAGMA user_version = 5", "invalid-statement");
    expectRejection("CREATE TABLE x (id TEXT)", "invalid-statement");
    expectRejection("ATTACH DATABASE ':memory:' AS other", "invalid-statement");
    expectRejection("", "invalid-statement");
  });

  it("rejects savepoint statements (bytecode looks harmless but mutates transaction state)", () => {
    expectRejection("SAVEPOINT sp1", "invalid-statement");
    expectRejection("RELEASE sp1", "invalid-statement");
    expectRejection("ROLLBACK TO sp1", "invalid-statement");
  });

  it("rejects read pragmas (no write opcodes, but still not a query)", () => {
    expectRejection("PRAGMA user_version", "invalid-statement");
    expectRejection("PRAGMA compile_options", "invalid-statement");
  });

  it("rejects multi-statement input", () => {
    expectRejection("SELECT * FROM items; DELETE FROM item", "multi-statement");
    expectRejection("SELECT 1;;SELECT 2", "multi-statement");
  });

  it("rejects writes smuggled behind a CTE", () => {
    expectRejection("WITH t AS (SELECT 1) INSERT INTO item (id, title) SELECT 'x', 'y' FROM t", "write-detected");
    expectRejection("WITH t AS (SELECT 1) UPDATE item SET title = 'x'", "write-detected");
  });

  it("rejects whole-table deletes that compile to Clear instead of OpenWrite", () => {
    expectRejection("WITH t AS (SELECT 1) DELETE FROM item", "write-detected");
  });

  it("allows reads of any table, including internal ones and sqlite_master", () => {
    const { rows } = guard.execute<{ payload: string }>({ sql: "SELECT payload FROM persisted_crdt_events" });
    expect(rows).toEqual([{ payload: "secret" }]);

    expect(guard.check({ sql: "SELECT name FROM sqlite_master" })).toEqual({ allowed: true });
  });

  it("rejects invalid SQL with the underlying error message", () => {
    const verdict = expectRejection("SELECT * FRO items", "invalid-sql");
    expect(verdict.message).toContain("SQL error");

    expectRejection("SELECT * FROM no_such_table", "invalid-sql");
  });

  it("execute throws QueryGuardError carrying the rejection", () => {
    expect(() => guard.execute({ sql: "DELETE FROM item" })).toThrowError(QueryGuardError);
    try {
      guard.execute({ sql: "WITH t AS (SELECT 1) DELETE FROM item" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueryGuardError);
      expect((error as QueryGuardError).rejection.code).toBe("write-detected");
    }
  });
});

// `readableTables` names base tables; views flatten into them before the bytecode exists, so the
// allow-list is checked against the root pages a statement actually opens.
describe("createQueryGuard with readableTables", () => {
  let restricted: QueryGuard;

  beforeAll(() => {
    restricted = createQueryGuard({ executor, readableTables: ["item"] });
  });

  function expectDenied(sql: string, parameters: readonly unknown[] = []) {
    const verdict = restricted.check({ sql, parameters });
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe("table-denied");
    }
    return verdict as { allowed: false; code: string; message: string };
  }

  it("allows the readable table and views over it", () => {
    expect(restricted.check({ sql: "SELECT * FROM items" })).toEqual({ allowed: true });
    expect(restricted.check({ sql: `SELECT * FROM "item"` })).toEqual({ allowed: true });
    expect(restricted.execute<{ title: string }>({ sql: "SELECT title FROM items" }).rows).toEqual([
      { title: "first" },
    ]);
  });

  it("allows indexes on a readable table and statements that open no table at all", () => {
    expect(restricted.check({ sql: `SELECT * FROM "item" INDEXED BY "item_title_idx" WHERE title = 'first'` })).toEqual(
      { allowed: true },
    );
    expect(restricted.check({ sql: "SELECT 1" })).toEqual({ allowed: true });
    expect(restricted.check({ sql: "SELECT value FROM json_each('[1,2]')" })).toEqual({ allowed: true });
  });

  it("denies a denied table however it is reached", () => {
    expect(expectDenied(`SELECT * FROM "secret"`).message).toContain(`"secret"`);
    expectDenied("SELECT * FROM secrets");
    expectDenied("SELECT (SELECT token FROM secrets LIMIT 1) AS leak FROM items");
    expectDenied("WITH s AS (SELECT * FROM secrets) SELECT * FROM s");
    expectDenied(`SELECT * FROM "secret" AS "items"`);
    expectDenied("SELECT count(*) FROM secrets WHERE token = 'hunter2'");
    expectDenied("SELECT * FROM items UNION ALL SELECT * FROM secrets");
  });

  it("denies the internal event log and the schema table", () => {
    expectDenied("SELECT payload FROM persisted_crdt_events");
    expectDenied("SELECT name FROM sqlite_master");
    expectDenied("SELECT name FROM sqlite_schema");
  });

  it("denies pragma functions, which would enumerate hidden tables", () => {
    expect(expectDenied("SELECT * FROM pragma_table_list()").message).toContain("Pragma functions");
    expectDenied(`SELECT * FROM pragma_table_info('secret')`);
  });

  it("lists the readable tables so the agent can retry", () => {
    expect(expectDenied(`SELECT * FROM "secret"`).message).toContain("You can only read these tables: item.");
  });

  it("execute throws QueryGuardError for denied tables", () => {
    expect(() => restricted.execute({ sql: `SELECT * FROM "secret"` })).toThrowError(QueryGuardError);
  });

  it("fails closed when the schema mapping cannot be read", () => {
    const failing: AiDbExecutor = {
      execute: <TResult>(query: { sql: string; parameters: readonly unknown[] }) => {
        if (query.sql.includes("sqlite_master")) {
          throw new Error("no schema access");
        }
        return executor.execute<TResult>(query);
      },
      transaction: (callback) => callback(failing),
    };

    const verdict = createQueryGuard({ executor: failing, readableTables: ["item"] }).check({
      sql: "SELECT * FROM items",
    });

    expect(verdict).toEqual({
      allowed: false,
      code: "table-denied",
      message: "The tables this statement reads could not be verified, so it was rejected.",
    });
  });
});

describe("runWithForcedRollback", () => {
  it("rolls back writes while still returning the callback result", () => {
    const before = countItems();

    const insideCount = runWithForcedRollback(executor, (tx) => {
      tx.execute({ sql: `INSERT INTO "item" ("id", "title") VALUES ('tmp', 'tmp')`, parameters: [] });
      return tx.execute<{ count: number }>({ sql: `SELECT count(*) AS count FROM "item"`, parameters: [] }).rows[0]
        ?.count;
    });

    expect(insideCount).toBe(before + 1);
    expect(countItems()).toBe(before);
  });

  it("propagates callback errors after rolling back", () => {
    const before = countItems();

    expect(() =>
      runWithForcedRollback(executor, (tx) => {
        tx.execute({ sql: `INSERT INTO "item" ("id", "title") VALUES ('tmp2', 'tmp')`, parameters: [] });
        throw new Error("boom");
      }),
    ).toThrowError("boom");

    expect(countItems()).toBe(before);
  });
});
