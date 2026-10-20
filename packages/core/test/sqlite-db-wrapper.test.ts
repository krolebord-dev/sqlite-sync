import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/wasm-reactive-db";
import { SQLiteDbWrapper } from "../src/sqlite-db-wrapper";

describe(SQLiteDbWrapper, () => {
  it("preserves literals alongside named parameters when reusing a prepared Kysely query", async () => {
    const reactiveDb = await createSQLiteReactiveDb({
      snapshot: new Uint8Array(),
      logger: () => {},
    });

    try {
      const query = (parameters: { id: string; count: number; optional: string | null }) =>
        reactiveDb.db.executePrepared("mixed-parameters", parameters, (db, params) =>
          db.selectNoFrom((eb) => [
            eb.val(params("id")).as("id"),
            eb.val(params("id")).as("repeatedId"),
            eb.val(params("count")).as("count"),
            eb.val(params("optional")).as("optional"),
            eb.val("id").as("keyLiteral"),
            eb.val("constant").as("textLiteral"),
            eb.val(42).as("numberLiteral"),
            eb.val(null).as("nullLiteral"),
          ]),
        );

      const literals = { keyLiteral: "id", textLiteral: "constant", numberLiteral: 42, nullLiteral: null };
      expect(query({ id: "first", count: 1, optional: null })).toEqual([
        { id: "first", repeatedId: "first", count: 1, optional: null, ...literals },
      ]);
      expect(query({ id: "second", count: 2, optional: "present" })).toEqual([
        { id: "second", repeatedId: "second", count: 2, optional: "present", ...literals },
      ]);
    } finally {
      reactiveDb.dispose();
    }
  });

  it("uses an explicit option rather than the logger level to skip afterMutatingStatement", async () => {
    const { db } = await createSQLiteReactiveDb({
      snapshot: new Uint8Array(),
      logger: () => {},
    });
    db.execute(`create table "item" ("id" integer primary key)`);

    let callbackCount = 0;
    db.setAfterMutatingStatement(() => {
      callbackCount++;
    });

    db.execute(`insert into "item" default values`, { loggerLevel: "system" });
    db.execute(`insert into "item" default values`, { skipAfterMutatingStatement: true });

    expect(callbackCount).toBe(1);
  });
});
