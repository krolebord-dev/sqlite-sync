import { RPCHandler } from "@orpc/server/fetch";
import { itemIndexingRouter } from "./routers/item-indexing";
import { listSettingsRouter } from "./routers/list-settings";
import { listWatchProvidersRouter } from "./routers/watch-providers";

export const listDbOrpcRouter = {
  itemIndexing: itemIndexingRouter,
  listSettings: listSettingsRouter,
  watchProviders: listWatchProvidersRouter,
};

export const listOrpcHandler = new RPCHandler(listDbOrpcRouter, {
  plugins: [],
});
