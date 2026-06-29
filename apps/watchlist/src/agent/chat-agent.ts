import { type Session, Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createDbTools } from "@sqlite-sync/ai";
import type { LanguageModel, ToolSet } from "ai";
import { getServerByName } from "partyserver";
import { tmdbTools } from "./agent-tools";

// Reuses the OpenRouter preset already configured for this app's AI features.
const CHAT_MODEL = "@preset/fast-and-efficient";

export class ChatAgent extends Think<Env> {
  maxSteps = 10;

  getModel(): LanguageModel {
    const openrouter = createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY });
    return openrouter.chat(CHAT_MODEL);
  }

  async beforeTurn(_ctx: TurnContext): Promise<TurnConfig> {
    return { model: this.getModel() };
  }

  configureSession(session: Session): Session {
    return session
      .withContext("instructions", {
        description: "Base watchlist assistant instructions",
        provider: { get: async () => this.buildInstructions() },
      })
      .withCachedPrompt();
  }

  getTools(): ToolSet {
    return {
      ...createDbTools({
        access: () => this.getListDbStub(),
        mutations: true,
      }),
      ...tmdbTools({ env: this.env, listDbName: this.getListDbName() }),
    };
  }

  private buildInstructions(): string {
    return [
      "You are the built-in assistant for a movie and TV watchlist app.",
      "You help the user reason about the items on their list and make changes when asked.",
      "The list lives in a synced SQLite database. Call getDbSchema before reasoning about the data.",
      "Use queryDb (read-only SQL) to look things up — what's unwatched, by tag, by rating, etc.",
      "To add a title, first call searchTitles (or getTrending) to get the real TMDB-backed row, then add it with mutateDb item-created using that returned object as the payload (omit id; an id is generated). Never invent tmdbId or other metadata — always source new items from searchTitles/getTrending.",
      "Use mutateDb for other changes: marking items watched (set watchedAt to the current time in unix epoch milliseconds), updating tags or ratings, reprioritizing, or removing items. Query first when updating or deleting existing rows.",
      "Use getWatchProviders (with a title's tmdbId and type) when the user asks where to watch something.",
      "Only mutate when the user clearly asks for a change. Be concise and use markdown when it helps.",
    ].join("\n");
  }

  // Agent instances are named `${listDbName}:${conversationId}`; the prefix is the sync DO's name.
  private getListDbName(): string {
    const separatorIndex = this.name.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`Unexpected agent name without a list-db prefix: ${this.name}`);
    }
    return this.name.slice(0, separatorIndex);
  }

  private async getListDbStub() {
    return await getServerByName(this.env.ListDbServer, this.getListDbName(), {
      locationHint: "weur",
    });
  }
}
