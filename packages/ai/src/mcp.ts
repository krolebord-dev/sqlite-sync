import type { McpServer, RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AiMutationInput, AiQueryInput } from "./db-access";
import {
  type DbToolsAccess,
  getDbSchemaDescription,
  getDbSchemaInputSchema,
  mutateDbDescription,
  mutateDbInputSchema,
  mutationsDisabledResult,
  queryDbDescription,
  queryDbInputSchema,
} from "./tool-definitions";

type MaybePromise<T> = T | Promise<T>;

/** Per-request context from the MCP SDK. Carries `authInfo` when the transport is authenticated. */
export type DbMcpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type DbMcpDatabase = {
  id: string;
  name: string;
  description?: string;
};

export type DbMcpDatabases = {
  /** Databases the caller may use. Only these should resolve in `access`. */
  list(extra: DbMcpRequestExtra): MaybePromise<DbMcpDatabase[]>;
  /**
   * Resolves a database by the id the model passed. Must check that the caller may use it,
   * since the id is model input. Return `null` for unknown or forbidden ids.
   */
  access(databaseId: string, extra: DbMcpRequestExtra): MaybePromise<DbToolsAccess | null>;
};

export type RegisterDbToolsOptions = {
  /** Register the write-capable `mutateDb` tool. The access object must also implement `mutate`. */
  mutations?: boolean;
} & (
  | {
      /** Single-database mode: the server, session, or auth context already identifies the database. */
      access: (extra: DbMcpRequestExtra) => MaybePromise<DbToolsAccess>;
      databases?: never;
    }
  | {
      /** Multi-database mode: adds `listDatabases` and a required `databaseId` input to every tool. */
      databases: DbMcpDatabases;
      access?: never;
    }
);

export type RegisteredDbTools = {
  getDbSchema: RegisteredTool;
  queryDb: RegisteredTool;
  mutateDb?: RegisteredTool;
  listDatabases?: RegisteredTool;
};

type DatabaseArgs = { databaseId?: unknown };

const readOnlyAnnotations: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const mutationAnnotations: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: "text", text }], isError } : { content: [{ type: "text", text }] };
}

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    ...("error" in value ? { isError: true } : {}),
  };
}

/**
 * Registers the synced-database tools (`getDbSchema`, `queryDb`, optional `mutateDb`) on an
 * existing MCP server, next to any domain tools the app registers itself. Access is resolved on
 * every call, so the tools hold no state and work with session-based and stateless transports.
 *
 * Query and mutation results are returned as JSON text plus `structuredContent`; `{ error }`
 * results are flagged with `isError`.
 */
export function registerDbTools(server: McpServer, opts: RegisterDbToolsOptions): RegisteredDbTools {
  const databases = opts.databases;
  const databaseShape = databases
    ? { databaseId: z.string().describe("The id of a database returned by listDatabases.") }
    : {};

  async function withAccess(
    args: DatabaseArgs,
    extra: DbMcpRequestExtra,
    run: (access: DbToolsAccess) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    if (!databases) {
      return await run(await opts.access(extra));
    }
    const databaseId = typeof args.databaseId === "string" ? args.databaseId : "";
    const access = await databases.access(databaseId, extra);
    if (!access) {
      return textResult(
        `Unknown or unavailable database "${databaseId}". Call listDatabases to see the available databases.`,
        true,
      );
    }
    return await run(access);
  }

  const registered: RegisteredDbTools = {
    getDbSchema: server.registerTool(
      "getDbSchema",
      {
        title: "Get database schema",
        description: getDbSchemaDescription,
        inputSchema: z.strictObject({ ...databaseShape, ...getDbSchemaInputSchema.shape }),
        annotations: readOnlyAnnotations,
      },
      (args: DatabaseArgs, extra) => withAccess(args, extra, async (access) => textResult(await access.getSchemaDoc())),
    ),
    queryDb: server.registerTool(
      "queryDb",
      {
        title: "Query database",
        description: queryDbDescription,
        inputSchema: z.strictObject({ ...databaseShape, ...queryDbInputSchema.shape }),
        annotations: readOnlyAnnotations,
      },
      ({ databaseId, ...input }: AiQueryInput & DatabaseArgs, extra) =>
        withAccess({ databaseId }, extra, async (access) => jsonResult(await access.query(input))),
    ),
  };

  if (opts.mutations) {
    registered.mutateDb = server.registerTool(
      "mutateDb",
      {
        title: "Modify database",
        description: mutateDbDescription,
        inputSchema: z.strictObject({ ...databaseShape, ...mutateDbInputSchema.shape }),
        annotations: mutationAnnotations,
      },
      ({ databaseId, ...input }: AiMutationInput & DatabaseArgs, extra) =>
        withAccess({ databaseId }, extra, async (access) =>
          jsonResult(access.mutate ? await access.mutate(input) : mutationsDisabledResult),
        ),
    );
  }

  if (databases) {
    registered.listDatabases = server.registerTool(
      "listDatabases",
      {
        title: "List databases",
        description:
          "List the synced databases you can access. Pass a database's id as `databaseId` to the other database tools.",
        inputSchema: z.strictObject({}),
        annotations: readOnlyAnnotations,
      },
      async (_args, extra) => jsonResult({ databases: await databases.list(extra) }),
    );
  }

  return registered;
}

/**
 * Default server `instructions` for an MCP server that registers the database tools. Pass the
 * result to the `McpServer` constructor. Put app-level notes in `overview`.
 */
export function createDbMcpInstructions(opts?: {
  overview?: string;
  multiDatabase?: boolean;
  mutations?: boolean;
}): string {
  const lines: string[] = [];
  const overview = opts?.overview?.trim();
  if (overview) {
    lines.push(overview, "");
  }
  if (opts?.multiDatabase) {
    lines.push(
      "Data lives in synced SQLite databases. Call listDatabases first, then pass the chosen database's id as `databaseId` to every other database tool.",
    );
  } else {
    lines.push("Data lives in a synced SQLite database.");
  }
  lines.push("Call getDbSchema before reasoning about the data, and use queryDb (read-only SQL) to look things up.");
  if (opts?.mutations) {
    lines.push("Write with mutateDb only, never through SQL. Query the current rows before updating or deleting them.");
  }
  return lines.join("\n");
}
