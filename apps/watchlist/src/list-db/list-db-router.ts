import { RPCHandler } from "@orpc/server/fetch";
import { aiSuggestionsRouter } from "./routers/ai-suggestions";
import { listSettingsRouter } from "./routers/list-settings";

export const listDbOrpcRouter = {
  aiSuggestions: aiSuggestionsRouter,
  listSettings: listSettingsRouter,
};

export const listOrpcHandler = new RPCHandler(listDbOrpcRouter, {
  plugins: [],
});
