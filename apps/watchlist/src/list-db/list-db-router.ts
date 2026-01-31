import { RPCHandler } from "@orpc/server/fetch";
import { aiRecommendationsRouter } from "./routers/ai-recommendations";
import { aiSuggestionsRouter } from "./routers/ai-suggestions";
import { listSettingsRouter } from "./routers/list-settings";
import { listWatchProvidersRouter } from "./routers/watch-providers";

export const listDbOrpcRouter = {
  aiRecommendations: aiRecommendationsRouter,
  aiSuggestions: aiSuggestionsRouter,
  listSettings: listSettingsRouter,
  watchProviders: listWatchProvidersRouter,
};

export const listOrpcHandler = new RPCHandler(listDbOrpcRouter, {
  plugins: [],
});
