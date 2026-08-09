import { createRouterClient, type RouterClient } from "@orpc/server";
import {
  type AiDbAccess,
  type AiMutationInput,
  type AiMutationResult,
  type AiQueryInput,
  type AiQueryResult,
  createAiDbAccess,
} from "@sqlite-sync/ai";
import { durableObjectAdapter, type RemoteHandler, type TypedPersistedCrdtEvent } from "@sqlite-sync/cloudflare";
import { type Connection, Server } from "partyserver";
import { listDbOrpcRouter, listOrpcHandler } from "./list-db-router";
import { syncDbSchema } from "./migrations";
import type { ORPCContext } from "./routers/orpc-base";
import { listDbSchemaDocContext } from "./schema-doc";

export class ListDbServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private remoteHandler: RemoteHandler = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private context: ORPCContext = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private orpc: RouterClient<typeof listDbOrpcRouter> = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private aiDbAccess: AiDbAccess = null!;

  async onStart() {
    const { syncDb, remoteHandler } = await durableObjectAdapter.createCrdtStorage({
      syncDbSchema,
      crdtEventsTable: "crdt_events",
      nodeId: this.ctx.id.toString(),
      storage: this.ctx.storage,
      broadcastPayload: (payload) => {
        this.broadcast(payload);
      },
    });

    this.remoteHandler = remoteHandler;
    this.context = {
      env: this.env,
      syncDb,
      kv: this.ctx.storage.kv,
    };
    this.orpc = createRouterClient(listDbOrpcRouter, {
      context: this.context,
    });

    this.aiDbAccess = createAiDbAccess({
      executor: syncDb.unsafe,
      storage: syncDb,
      syncDbSchema,
      context: listDbSchemaDocContext,
    });

    syncDb.addEventListener("event-applied", (event) => {
      this.onEventApplied(event.payload).catch((error) => {
        console.error("Error applying event", event, error);
      });
    });
  }

  // RPC surface for the ChatAgent (resolved via getServerByName). Method names match
  // @sqlite-sync/ai's DbToolsAccess so the agent's createDbTools can call them directly.
  getSchemaDoc(): string {
    return this.aiDbAccess.getSchemaDoc();
  }

  query(input: AiQueryInput): AiQueryResult {
    return this.aiDbAccess.query(input);
  }

  mutate(input: AiMutationInput): AiMutationResult {
    return this.aiDbAccess.mutate?.(input) ?? { error: "Database mutations are not enabled." };
  }

  // Streaming availability for the ChatAgent's getWatchProviders tool — reuses the existing
  // list handler so the user's region/filter settings (in this DO's kv) apply.
  getWatchProviders(input: { tmdbId: number; type: "movie" | "tv" }) {
    return this.orpc.watchProviders.getItemWatchProviders(input);
  }

  onMessage(connection: Connection, message: string) {
    const messageResult = this.remoteHandler.handleMessage(message);

    if (!messageResult.success) {
      console.log("Invalid message", messageResult.error);
      return;
    }

    connection.send(messageResult.payload);
  }

  async onRequest(request: Request): Promise<Response> {
    const { matched, response } = await listOrpcHandler.handle(request, {
      prefix: `/list-db/list-db-server/${this.name}/rpc`,
      context: this.context,
    });

    if (matched) {
      return response;
    }

    return super.onRequest(request);
  }

  async onEventApplied(event: TypedPersistedCrdtEvent<typeof syncDbSchema>) {
    if (event.type === "item-created" && event.dataset === "_item") {
      const aiSuggestionsEnabled = this.ctx.storage.kv.get<boolean>("settings:ai-suggestions-enabled");
      if (aiSuggestionsEnabled !== false) {
        await this.orpc.aiSuggestions.suggestTags({ itemId: event.item_id });
      }
    }
  }
}
