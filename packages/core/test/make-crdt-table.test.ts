import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { t } from "../src/schema/table-builder";
import type { CrdtChangeIntent } from "../src/sqlite-crdt/crdt-storage";
import {
  CRDT_CHANGE_INTENTS_TABLE,
  crdtViewColumnsFromTable,
  createCrdtViewStatements,
  makeCrdtTable,
} from "../src/sqlite-crdt/make-crdt-table";

const WORKERD_EXPR_DEPTH = 100;
const WIDE_TABLE_COLUMNS = 90;

function wideColumnNames(columnCount: number) {
  return [
    "id",
    ...Array.from({ length: columnCount - 2 }, (_, index) => `c${String(index).padStart(2, "0")}`),
    "tombstone",
  ];
}

function viewColumns(columnNames: string[]) {
  return columnNames.map((name) => ({ name, nullable: true }));
}

describe("CRDT change intent triggers", () => {
  it("builds a null-safe sparse update payload using binary text comparison", async () => {
    const reactiveDb = await createSQLiteReactiveDb({
      snapshot: new Uint8Array(),
      logger: () => {},
    });
    const db = reactiveDb.db;

    db.execute(`
      create table "item" (
        "id" text primary key,
        "label" text collate nocase,
        "note" text,
        "tombstone" integer not null default 0
      )
    `);
    makeCrdtTable({
      db,
      baseTableName: "item",
      crdtTableName: "_item",
    });
    db.execute(`insert into "item" ("id", "label", "note") values ('item-1', 'initial', 'remove me')`);

    db.execute(`update "_item" set "label" = 'INITIAL', "note" = null where "id" = 'item-1'`);

    const [intent] = db.execute<CrdtChangeIntent>(`select * from "${CRDT_CHANGE_INTENTS_TABLE}" order by "seq"`).rows;
    expect(intent).toMatchObject({
      dataset: "item",
      type: "item-updated",
      item_id: "item-1",
      new_item_id: "item-1",
      payload_json: `{"label":"INITIAL","note":null}`,
    });
  });

  it("leaves NULLs of NOT NULL sync schema columns out of create payloads", async () => {
    const reactiveDb = await createSQLiteReactiveDb({
      snapshot: new Uint8Array(),
      logger: () => {},
    });
    const db = reactiveDb.db;
    const table = t.table({
      title: t.text().default("untitled"),
      note: t.text().nullable().default("draft"),
    });

    db.execute(`
      create table "_item" (
        "id" text primary key not null,
        "title" text not null default 'untitled',
        "note" text default 'draft',
        "tombstone" integer not null default 0
      )
    `);
    for (const sql of createCrdtViewStatements({
      baseTableName: "_item",
      crdtTableName: "item",
      columns: crdtViewColumnsFromTable(table),
    })) {
      db.execute(sql);
    }

    db.execute(`insert into "item" ("id") values ('item-1')`);
    db.execute(`insert into "item" ("id", "title") values ('item-2', 'Hello')`);

    const payloads = db
      .execute<CrdtChangeIntent>(`select * from "${CRDT_CHANGE_INTENTS_TABLE}" order by "seq"`)
      .rows.map((intent) => JSON.parse(intent.payload_json));
    expect(payloads).toEqual([
      { id: "item-1", note: null },
      { id: "item-2", title: "Hello", note: null },
    ]);
  });

  it("creates wide-table triggers under workerd's expression depth cap", async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB({ filename: ":memory:" });
    try {
      sqlite3.capi.sqlite3_limit(db, sqlite3.capi.SQLITE_LIMIT_EXPR_DEPTH, WORKERD_EXPR_DEPTH);
      const leftDeep = Array.from({ length: WORKERD_EXPR_DEPTH + 20 }, () => "'x'").join("||");
      expect(() => db.exec(`select ${leftDeep}`)).toThrow(/Expression tree is too large/);

      const columnNames = wideColumnNames(WIDE_TABLE_COLUMNS);
      const extraColumns = columnNames.filter((name) => name !== "id" && name !== "tombstone");
      db.exec(`
        create table "wide" (
          "id" text primary key,
          ${extraColumns.map((name) => `"${name}" text`).join(",\n          ")},
          "tombstone" integer not null default 0
        )
      `);
      for (const sql of createCrdtViewStatements({
        baseTableName: "wide",
        crdtTableName: "_wide",
        columns: viewColumns(columnNames),
      })) {
        db.exec(sql);
      }

      const insertColumns = ["id", ...extraColumns, "tombstone"];
      const insertValues = ["'row-1'", ...extraColumns.map((name) => `'${name}'`), "0"];
      db.exec(
        `insert into "_wide" (${insertColumns.map((name) => `"${name}"`).join(", ")}) values (${insertValues.join(", ")})`,
      );

      const createdRows = db.exec({
        sql: `select * from "${CRDT_CHANGE_INTENTS_TABLE}" order by "seq"`,
        rowMode: "object",
        returnValue: "resultRows",
      });
      const created = createdRows[0] as { payload_json: string };
      expect(created).toMatchObject({ type: "item-created" });
      const createdPayload = JSON.parse(created.payload_json) as Record<string, unknown>;
      expect(Object.keys(createdPayload)).toEqual(columnNames.filter((name) => name !== "tombstone"));
      expect(createdPayload.c00).toBe("c00");

      db.exec(`delete from "${CRDT_CHANGE_INTENTS_TABLE}"`);
      db.exec(
        `insert into "wide" (${insertColumns.map((name) => `"${name}"`).join(", ")}) values (${insertValues.join(", ")})`,
      );
      db.exec(`update "_wide" set "c00" = 'changed', "c01" = "c01" where "id" = 'row-1'`);

      const updatedRows = db.exec({
        sql: `select * from "${CRDT_CHANGE_INTENTS_TABLE}" order by "seq"`,
        rowMode: "object",
        returnValue: "resultRows",
      });
      expect(updatedRows[0]).toMatchObject({
        type: "item-updated",
        payload_json: `{"c00":"changed"}`,
      });
    } finally {
      db.close();
    }
  });

  it("balances concat trees in generated trigger SQL", () => {
    const [, , insertTrigger, updateTrigger] = createCrdtViewStatements({
      baseTableName: "wide",
      crdtTableName: "_wide",
      columns: viewColumns(wideColumnNames(WIDE_TABLE_COLUMNS)),
    });
    expect(insertTrigger).toContain(")||(");
    expect(updateTrigger).toContain(")||(");
  });
});
