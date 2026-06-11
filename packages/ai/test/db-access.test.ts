import { createMigrations, createSyncDbSchema } from "@sqlite-sync/core";
import { describe, expect, it } from "vitest";
import { type AiDbExecutor, createAiDbAccess } from "../src/db-access";

type ItemRow = {
  id: string;
  title: string;
};

function createFakeExecutor() {
  const calls: string[] = [];
  const tableInfoRows = [
    { cid: 0, name: "id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { cid: 1, name: "title", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { cid: 2, name: "tombstone", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
  ];

  const executor: AiDbExecutor = {
    execute: <TResult>(query: { sql: string; parameters: readonly unknown[] }) => {
      calls.push(query.sql);
      return { rows: tableInfoRows as TResult[] };
    },
    transaction: (callback) => callback(executor),
  };

  return { executor, calls };
}

const syncDbSchema = createSyncDbSchema({ migrations: createMigrations(() => ({ 0: [] })) })
  .addTable<ItemRow>()
  .withConfig({ baseTableName: "item", crdtTableName: "items" })
  .build();

describe("createAiDbAccess", () => {
  it("builds the schema doc through the executor", () => {
    const { executor, calls } = createFakeExecutor();
    const access = createAiDbAccess({
      executor,
      syncDbSchema,
      context: { tables: { items: { description: "The user's items." } } },
    });

    const doc = access.getSchemaDoc();

    expect(calls).toEqual(['PRAGMA table_info("item")']);
    expect(doc).toBe(
      ["## items", "", "The user's items.", "", "Columns:", "- `id` TEXT NOT NULL", "- `title` TEXT NOT NULL"].join(
        "\n",
      ),
    );
  });

  it("introspects once and caches the doc", () => {
    const { executor, calls } = createFakeExecutor();
    const access = createAiDbAccess({ executor, syncDbSchema });

    const first = access.getSchemaDoc();
    const second = access.getSchemaDoc();

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });
});
