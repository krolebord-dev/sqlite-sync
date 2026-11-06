import { afterEach, describe, expect, it, vi } from "vitest";
import { type ReconciledRows, reconcileRows } from "../src/memory-db/reconcile-rows";
import type { SQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";
import type { SqliteDriverRows, SqliteDriverValue } from "../src/sqlite-driver";

type Todo = { id: string; title: string; done: number; blob: Uint8Array | null };
let db: SQLiteReactiveDb<{ todo: Todo }> | null = null;

async function createDb() {
  db = await createSQLiteReactiveDb<{ todo: Todo }>({ snapshot: new Uint8Array(), logger: () => {} });
  db.db.execute(`CREATE TABLE "todo" ("id" TEXT PRIMARY KEY, "title" TEXT, "done" INTEGER, "blob" BLOB)`);
  for (let i = 0; i < 5; i++) {
    db.db.execute({
      sql: `INSERT INTO "todo" VALUES (?, ?, 0, ?)`,
      parameters: [`${i}`, `t${i}`, new Uint8Array([i])],
    });
  }
  return db;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

afterEach(() => {
  db?.dispose();
  db = null;
});

describe("live query structural sharing", () => {
  it("reuses unchanged rows and replaces only the changed one", async () => {
    const db = await createDb();
    const entry = db.getSharedLiveQuery<Todo>({ sql: `SELECT * FROM "todo" ORDER BY id`, parameters: [] });
    const onChange = vi.fn();
    entry.subscribe(onChange);
    const before = entry.getRows();

    db.db.execute(`UPDATE "todo" SET done = 1 WHERE id = '2'`);
    await tick();

    const after = entry.getRows();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(after).not.toBe(before);
    expect(after.map((row, i) => row === before[i])).toEqual([true, true, false, true, true]);
  });

  it("keeps the same array and skips notification when the result did not change", async () => {
    const db = await createDb();
    const entry = db.getSharedLiveQuery<Todo>({
      sql: `SELECT * FROM "todo" WHERE done = 0 AND id < '2'`,
      parameters: [],
    });
    const onChange = vi.fn();
    entry.subscribe(onChange);
    const before = entry.getRows();

    db.db.execute(`UPDATE "todo" SET title = 'other' WHERE id = '4'`); // same table, outside the result
    await tick();

    expect(entry.getRows()).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("matches by id after inserts shift positions", async () => {
    const db = await createDb();
    const entry = db.getSharedLiveQuery<Todo>({ sql: `SELECT * FROM "todo" ORDER BY id`, parameters: [] });
    entry.subscribe(() => {});
    const before = entry.getRows();

    db.db.execute(`INSERT INTO "todo" VALUES ('!', 'first', 0, NULL)`);
    await tick();

    const after = entry.getRows();
    expect(after[0].id).toBe("!");
    expect(after.slice(1).every((row, i) => row === before[i])).toBe(true);
  });

  it("compares blobs by bytes", () => {
    const prev = previous(["id", "blob"], [["a", new Uint8Array([1, 2])]]);
    expect(reconcileRows(prev, raw(["id", "blob"], [["a", new Uint8Array([1, 2])]]))).toBe(prev.rows);
    expect(reconcileRows(prev, raw(["id", "blob"], [["a", new Uint8Array([1, 3])]]))[0]).not.toBe(prev.rows[0]);
  });

  it("does not share across a column change", () => {
    const prev = previous(["id", "title"], [["a", "x"]]);
    const result = reconcileRows(prev, raw(["id", "title", "extra"], [["a", "x", null]]));
    expect(result[0]).not.toBe(prev.rows[0]);
    expect(result[0]).toEqual({ id: "a", title: "x", extra: null });
  });

  it("is safe for keyless aggregates and duplicates", () => {
    const prev = previous(["n"], [[1], [1]]);
    expect(reconcileRows(prev, raw(["n"], [[1], [1]]))).toBe(prev.rows);
    const result = reconcileRows(prev, raw(["n"], [[1], [2]]));
    expect(result[0]).toBe(prev.rows[0]);
    expect(result[1]).toEqual({ n: 2 });
  });

  it("never reuses a row with the same id but different values (duplicate ids)", () => {
    const prev = previous(
      ["id", "tag"],
      [
        ["a", "x"],
        ["a", "y"],
      ],
    );
    const result = reconcileRows(
      prev,
      raw(
        ["id", "tag"],
        [
          ["a", "y"],
          ["a", "x"],
        ],
      ),
    );
    expect(result).toEqual([
      { id: "a", tag: "y" },
      { id: "a", tag: "x" },
    ]);
    expect(result[0]).not.toBe(prev.rows[0]);
  });

  it("distinguishes -0 from 0 and treats NaN as stable", () => {
    const prev = previous(["v"], [[0], [Number.NaN]]);
    const result = reconcileRows(prev, raw(["v"], [[-0], [Number.NaN]]));
    expect(result[0]).not.toBe(prev.rows[0]);
    expect(result[1]).toBe(prev.rows[1]);
  });

  it("notifies when refresh() switches parameters", async () => {
    const db = await createDb();
    const live = db.createLiveQuery<Todo>({ sql: `SELECT * FROM "todo" WHERE id = ?`, parameters: ["1"] });
    const onChange = vi.fn();
    live.subscribe(onChange);
    const before = live.getRows();
    live.refresh(["1"]);
    expect(onChange).not.toHaveBeenCalled();
    expect(live.getRows()).toBe(before);
    live.refresh(["2"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(live.getRows()[0].id).toBe("2");
  });
});

function raw(columns: string[], rows: SqliteDriverValue[][]): SqliteDriverRows {
  return { columns, rows };
}
function previous(columns: string[], rows: SqliteDriverValue[][]): ReconciledRows<any> {
  const r = raw(columns, rows);
  return { raw: r, rows: reconcileRows(null, r) };
}
