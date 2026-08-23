import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import { createSyncedDbDatabase } from "../src/sync-db";

describe("SyncedDb database facade", () => {
  it("drains through normal execution and bypasses only through unsafe execution", async () => {
    const reactiveDb = await createSQLiteReactiveDb<unknown>({
      snapshot: new Uint8Array(),
      logger: () => {},
    });

    try {
      reactiveDb.db.execute(`create table "item" ("id" integer primary key)`);

      let callbackCount = 0;
      reactiveDb.db.setAfterMutatingStatement(() => {
        callbackCount++;
      });

      const db = createSyncedDbDatabase(reactiveDb);
      const assertPublicTypes = () => {
        // @ts-expect-error draining can only be bypassed through db.unsafe
        db.execute(`select 1`, { skipAfterMutatingStatement: true });
        db.executeTransaction((tx) => {
          // @ts-expect-error prepared execution is not part of the public transaction facade
          tx.executePreparedRaw({ key: "unsafe", sql: "select 1" });
        });
      };
      void assertPublicTypes;

      db.execute(`insert into "item" default values`);
      db.unsafe.execute(`insert into "item" default values`);

      expect(callbackCount).toBe(1);

      db.executeTransaction((tx) => {
        expect(Object.keys(tx).sort()).toEqual(["execute", "executeKysely", "sql", "unsafe"]);
        expect(Object.keys(tx.unsafe).sort()).toEqual(["execute", "executeKysely"]);

        tx.execute(`insert into "item" default values`);
        tx.unsafe.execute(`insert into "item" default values`);
      });

      expect(callbackCount).toBe(2);
    } finally {
      reactiveDb.dispose();
    }
  });
});
