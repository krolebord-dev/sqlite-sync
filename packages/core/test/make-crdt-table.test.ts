import { describe, expect, it } from "vitest";
import { createSQLiteReactiveDb } from "../src/memory-db/sqlite-reactive-db";
import type { CrdtChangeIntent } from "../src/sqlite-crdt/crdt-storage";
import { CRDT_CHANGE_INTENTS_TABLE, makeCrdtTable } from "../src/sqlite-crdt/make-crdt-table";

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
});
