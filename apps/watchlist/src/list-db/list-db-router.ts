import { RPCHandler } from "@orpc/server/fetch";
import { aiRecommendationsRouter } from "./routers/ai-recommendations";
import { aiSuggestionsRouter } from "./routers/ai-suggestions";
import { listSettingsRouter } from "./routers/list-settings";

export const listDbOrpcRouter = {
  aiRecommendations: aiRecommendationsRouter,
  aiSuggestions: aiSuggestionsRouter,
  listSettings: listSettingsRouter,
};

export const listOrpcHandler = new RPCHandler(listDbOrpcRouter, {
  plugins: [],
});
