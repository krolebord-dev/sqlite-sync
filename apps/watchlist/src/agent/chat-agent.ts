import { type Session, Think, type TurnConfig, type TurnContext } from "@cloudflare/think";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createDbTools } from "@sqlite-sync/ai";
import type { LanguageModel, ToolSet } from "ai";
import { getServerByName } from "partyserver";

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
    return createDbTools({
      access: () => this.getListDbStub(),
      mutations: true,
    });
  }

  private buildInstructions(): string {
    return [
      "You are the built-in assistant for a movie and TV watchlist app.",
      "You help the user reason about the items on their list and make changes when asked.",
      "The list lives in a synced SQLite database. Call getDbSchema before reasoning about the data.",
      "Use queryDb (read-only SQL) to look things up — what's unwatched, by tag, by rating, etc.",
      "Use mutateDb for changes the user asks for: adding items, marking them watched (set watchedAt to the current time in unix epoch milliseconds), updating tags or ratings, or removing items. Query first when updating or deleting existing rows. For create events, omit ids; mutateDb generates them and returns createdIds.",
      "Only mutate when the user clearly asks for a change. Be concise and use markdown when it helps.",
    ].join("\n");
  }

  private async getListDbStub() {
    const separatorIndex = this.name.indexOf(":");
    if (separatorIndex === -1) {
      throw new Error(`Unexpected agent name without a list-db prefix: ${this.name}`);
    }
    const listDbName = this.name.slice(0, separatorIndex);
    return await getServerByName(this.env.ListDbServer, listDbName, {
      locationHint: "weur",
    });
  }
}
