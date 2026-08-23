import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { SQLiteDbWrapper } from "../src/sqlite-db-wrapper";

describe(SQLiteDbWrapper, () => {
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
