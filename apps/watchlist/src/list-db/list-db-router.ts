import { RPCHandler } from "@orpc/server/fetch";
import { aiSuggestionsRouter } from "./routers/ai-suggestions";

export const listDbOrpcRouter = {
  aiSuggestions: aiSuggestionsRouter,
};

export const listOrpcHandler = new RPCHandler(listDbOrpcRouter, {
  plugins: [],
});
