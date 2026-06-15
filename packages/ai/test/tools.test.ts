import { describe, expect, it } from "vitest";
import type { AiMutationInput, AiMutationResult, AiQueryInput, AiQueryResult } from "../src/db-access";
import { createDbTools } from "../src/tools";

const emptyResult: AiQueryResult = { rows: [], rowCount: 0, truncated: false };

describe("createDbTools", () => {
  it("exposes the getDbSchema and queryDb tools", () => {
    const tools = createDbTools({ access: () => ({ getSchemaDoc: () => "doc", query: () => emptyResult }) });
    expect(Object.keys(tools)).toEqual(["getDbSchema", "queryDb"]);
    expect(tools.getDbSchema?.description).toBeTruthy();
    expect(tools.queryDb?.description).toBeTruthy();
    expect(tools.mutateDb).toBeUndefined();
  });

  it("exposes mutateDb only when mutations are enabled", () => {
    const tools = createDbTools({
      access: () => ({
        getSchemaDoc: () => "doc",
        query: () => emptyResult,
        mutate: () => ({ applied: true, eventCount: 0, createdIds: [] }),
      }),
      mutations: true,
    });

    expect(Object.keys(tools)).toEqual(["getDbSchema", "queryDb", "mutateDb"]);
    expect(tools.mutateDb?.description).toBeTruthy();
  });

  it("resolves the access factory on every call and awaits async docs", async () => {
    let accessCalls = 0;
    const tools = createDbTools({
      access: async () => {
        accessCalls++;
        return { getSchemaDoc: async () => `doc ${accessCalls}`, query: async () => emptyResult };
      },
    });

    const execute = tools.getDbSchema?.execute;
    if (!execute) throw new Error("getDbSchema tool must be executable");

    await expect(execute({}, { toolCallId: "call-1", messages: [] })).resolves.toBe("doc 1");
    await expect(execute({}, { toolCallId: "call-2", messages: [] })).resolves.toBe("doc 2");
    expect(accessCalls).toBe(2);
  });

  it("queryDb forwards sql and parameters and returns the access result", async () => {
    const seen: AiQueryInput[] = [];
    const result: AiQueryResult = { rows: [{ id: "1" }], rowCount: 1, truncated: false };
    const tools = createDbTools({
      access: () => ({
        getSchemaDoc: () => "doc",
        query: (input) => {
          seen.push(input);
          return result;
        },
      }),
    });

    const execute = tools.queryDb?.execute;
    if (!execute) throw new Error("queryDb tool must be executable");

    await expect(
      execute({ sql: "SELECT id FROM items WHERE id = ?", parameters: ["1"] }, { toolCallId: "call-1", messages: [] }),
    ).resolves.toEqual(result);
    expect(seen).toEqual([{ sql: "SELECT id FROM items WHERE id = ?", parameters: ["1"] }]);
  });

  it("mutateDb forwards CRDT events and returns the access result", async () => {
    const seen: AiMutationInput[] = [];
    const result: AiMutationResult = { applied: true, eventCount: 1, createdIds: ["created-id"] };
    const tools = createDbTools({
      access: () => ({
        getSchemaDoc: () => "doc",
        query: () => emptyResult,
        mutate: (input) => {
          seen.push(input);
          return result;
        },
      }),
      mutations: true,
    });

    const execute = tools.mutateDb?.execute;
    if (!execute) throw new Error("mutateDb tool must be executable");

    const input: AiMutationInput = {
      events: [{ type: "item-updated", dataset: "item", item_id: "1", payload: { title: "updated" } }],
    };
    await expect(execute(input, { toolCallId: "call-1", messages: [] })).resolves.toEqual(result);
    expect(seen).toEqual([input]);
  });

  it("mutateDb returns an error when enabled without a mutate access method", async () => {
    const tools = createDbTools({
      access: () => ({ getSchemaDoc: () => "doc", query: () => emptyResult }),
      mutations: true,
    });

    const execute = tools.mutateDb?.execute;
    if (!execute) throw new Error("mutateDb tool must be executable");

    await expect(
      execute(
        { events: [{ type: "item-deleted", dataset: "item", item_id: "1" }] },
        { toolCallId: "call-1", messages: [] },
      ),
    ).resolves.toEqual({ error: "Database mutations are not enabled for this access object." });
  });
});
