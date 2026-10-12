import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AiMutationInput, AiMutationResult, AiQueryInput, AiQueryResult } from "../src/db-access";
import { createDbMcpInstructions, type RegisterDbToolsOptions, registerDbTools } from "../src/mcp";
import type { DbToolsAccess } from "../src/tool-definitions";

const emptyResult: AiQueryResult = { rows: [], rowCount: 0, truncated: false };

async function connect(opts: RegisterDbToolsOptions, setup?: (server: McpServer) => void) {
  const server = new McpServer({ name: "test", version: "1.0.0" });
  const registered = registerDbTools(server, opts);
  setup?.(server);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, registered };
}

function recordingAccess(overrides?: Partial<DbToolsAccess>) {
  const queries: AiQueryInput[] = [];
  const mutations: AiMutationInput[] = [];
  const access: DbToolsAccess = {
    getSchemaDoc: () => "schema doc",
    query: (input) => {
      queries.push(input);
      return emptyResult;
    },
    mutate: (input) => {
      mutations.push(input);
      return { applied: true, eventCount: input.events.length, createdIds: [] };
    },
    ...overrides,
  };
  return { access, queries, mutations };
}

describe("registerDbTools (single database)", () => {
  it("registers read-only tools by default", async () => {
    const { client, registered } = await connect({ access: () => recordingAccess().access });
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["getDbSchema", "queryDb"]);
    expect(registered.mutateDb).toBeUndefined();
    expect(registered.listDatabases).toBeUndefined();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.properties).not.toHaveProperty("databaseId");
    }
    expect(tools.find((tool) => tool.name === "queryDb")?.inputSchema.required).toEqual(["sql"]);
  });

  it("registers mutateDb as a destructive tool when mutations are enabled", async () => {
    const { client } = await connect({ access: () => recordingAccess().access, mutations: true });
    const { tools } = await client.listTools();
    const mutateDb = tools.find((tool) => tool.name === "mutateDb");

    expect(tools.map((tool) => tool.name)).toEqual(["getDbSchema", "queryDb", "mutateDb"]);
    expect(mutateDb?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(JSON.stringify(mutateDb?.inputSchema)).toContain('"not":{"required":["id"]}');
  });

  it("returns the schema doc as text and resolves access per call", async () => {
    let accessCalls = 0;
    const { client } = await connect({
      access: async (extra) => {
        accessCalls++;
        expect(extra.signal).toBeInstanceOf(AbortSignal);
        return { getSchemaDoc: async () => `doc ${accessCalls}`, query: () => emptyResult };
      },
    });

    await expect(client.callTool({ name: "getDbSchema", arguments: {} })).resolves.toEqual({
      content: [{ type: "text", text: "doc 1" }],
    });
    await expect(client.callTool({ name: "getDbSchema", arguments: {} })).resolves.toEqual({
      content: [{ type: "text", text: "doc 2" }],
    });
  });

  it("forwards queries and returns results as text and structured content", async () => {
    const result: AiQueryResult = { rows: [{ id: "1" }], rowCount: 1, truncated: false };
    const { access, queries } = recordingAccess({
      query: (input) => {
        queries.push(input);
        return result;
      },
    });
    const { client } = await connect({ access: () => access });

    const response = await client.callTool({
      name: "queryDb",
      arguments: { sql: "SELECT id FROM items WHERE id = ?", parameters: ["1"] },
    });

    expect(queries).toEqual([{ sql: "SELECT id FROM items WHERE id = ?", parameters: ["1"] }]);
    expect(response).toEqual({
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    });
  });

  it("flags error results with isError", async () => {
    const { client } = await connect({
      access: () => ({ getSchemaDoc: () => "doc", query: () => ({ error: "write detected" }) }),
    });

    const response = await client.callTool({ name: "queryDb", arguments: { sql: "DELETE FROM items" } });

    expect(response).toMatchObject({ isError: true, structuredContent: { error: "write detected" } });
  });

  it("rejects invalid arguments before resolving access", async () => {
    let accessCalls = 0;
    const { client } = await connect({
      access: () => {
        accessCalls++;
        return recordingAccess().access;
      },
    });

    const response = await client.callTool({ name: "queryDb", arguments: { sql: "SELECT 1", extra: true } });

    expect(response.isError).toBe(true);
    expect(accessCalls).toBe(0);
  });

  it("forwards mutation events", async () => {
    const { access, mutations } = recordingAccess();
    const { client } = await connect({ access: () => access, mutations: true });
    const input: AiMutationInput = {
      events: [{ type: "item-updated", dataset: "item", item_id: "1", payload: { title: "updated" } }],
    };

    const response = await client.callTool({ name: "mutateDb", arguments: input });

    expect(mutations).toEqual([input]);
    expect(response.structuredContent).toEqual({
      applied: true,
      eventCount: 1,
      createdIds: [],
    } satisfies AiMutationResult);
  });

  it("returns an error when mutations are enabled without a mutate access method", async () => {
    const { client } = await connect({
      access: () => ({ getSchemaDoc: () => "doc", query: () => emptyResult }),
      mutations: true,
    });

    const response = await client.callTool({
      name: "mutateDb",
      arguments: { events: [{ type: "item-deleted", dataset: "item", item_id: "1" }] },
    });

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { error: "Database mutations are not enabled for this access object." },
    });
  });

  it("coexists with tools the app registers on the same server", async () => {
    const { client } = await connect({ access: () => recordingAccess().access }, (server) => {
      server.registerTool("searchTitles", { inputSchema: z.object({ query: z.string() }) }, ({ query }) => ({
        content: [{ type: "text", text: `results for ${query}` }],
      }));
    });

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["getDbSchema", "queryDb", "searchTitles"]);
  });
});

describe("registerDbTools (multiple databases)", () => {
  function multiDatabaseSetup() {
    const lists = new Map([
      ["list-a", recordingAccess({ getSchemaDoc: () => "doc a" })],
      ["list-b", recordingAccess({ getSchemaDoc: () => "doc b" })],
    ]);
    const requestedIds: string[] = [];
    const opts: RegisterDbToolsOptions = {
      databases: {
        list: () => [
          { id: "list-a", name: "Movies" },
          { id: "list-b", name: "Shows", description: "TV only" },
        ],
        access: (databaseId) => {
          requestedIds.push(databaseId);
          return lists.get(databaseId)?.access ?? null;
        },
      },
      mutations: true,
    };
    return { lists, requestedIds, opts };
  }

  it("adds listDatabases and a required databaseId to every database tool", async () => {
    const { opts } = multiDatabaseSetup();
    const { client } = await connect(opts);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["getDbSchema", "queryDb", "mutateDb", "listDatabases"]);
    for (const tool of tools.filter((tool) => tool.name !== "listDatabases")) {
      expect(tool.inputSchema.properties).toHaveProperty("databaseId");
      expect(tool.inputSchema.required).toContain("databaseId");
    }
  });

  it("lists databases", async () => {
    const { opts } = multiDatabaseSetup();
    const { client } = await connect(opts);

    const response = await client.callTool({ name: "listDatabases", arguments: {} });

    expect(response.structuredContent).toEqual({
      databases: [
        { id: "list-a", name: "Movies" },
        { id: "list-b", name: "Shows", description: "TV only" },
      ],
    });
  });

  it("routes each call to the requested database without forwarding databaseId", async () => {
    const { opts, lists, requestedIds } = multiDatabaseSetup();
    const { client } = await connect(opts);

    const schema = await client.callTool({ name: "getDbSchema", arguments: { databaseId: "list-b" } });
    await client.callTool({ name: "queryDb", arguments: { databaseId: "list-a", sql: "SELECT 1" } });
    await client.callTool({
      name: "mutateDb",
      arguments: { databaseId: "list-b", events: [{ type: "item-deleted", dataset: "item", item_id: "1" }] },
    });

    expect(schema.content).toEqual([{ type: "text", text: "doc b" }]);
    expect(requestedIds).toEqual(["list-b", "list-a", "list-b"]);
    expect(lists.get("list-a")?.queries).toEqual([{ sql: "SELECT 1" }]);
    expect(lists.get("list-b")?.mutations).toEqual([
      { events: [{ type: "item-deleted", dataset: "item", item_id: "1" }] },
    ]);
  });

  it("returns an error for databases the access resolver rejects", async () => {
    const { opts } = multiDatabaseSetup();
    const { client } = await connect(opts);

    const response = await client.callTool({ name: "queryDb", arguments: { databaseId: "other", sql: "SELECT 1" } });

    expect(response).toEqual({
      content: [
        {
          type: "text",
          text: 'Unknown or unavailable database "other". Call listDatabases to see the available databases.',
        },
      ],
      isError: true,
    });
  });

  it("rejects calls without a databaseId", async () => {
    const { opts, requestedIds } = multiDatabaseSetup();
    const { client } = await connect(opts);

    const response = await client.callTool({ name: "queryDb", arguments: { sql: "SELECT 1" } });

    expect(response.isError).toBe(true);
    expect(requestedIds).toEqual([]);
  });
});

describe("createDbMcpInstructions", () => {
  it("describes the single-database read-only workflow by default", () => {
    const instructions = createDbMcpInstructions();

    expect(instructions).toContain("getDbSchema");
    expect(instructions).not.toContain("listDatabases");
    expect(instructions).not.toContain("mutateDb");
  });

  it("adds the overview, database selection, and mutation guidance when requested", () => {
    const instructions = createDbMcpInstructions({
      overview: "# Watchlist\n",
      multiDatabase: true,
      mutations: true,
    });

    expect(instructions.startsWith("# Watchlist\n\n")).toBe(true);
    expect(instructions).toContain("listDatabases");
    expect(instructions).toContain("mutateDb");
  });
});
