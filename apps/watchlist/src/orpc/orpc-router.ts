import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, ResponseHeadersPlugin } from "@orpc/server/plugins";
import { authRouter } from "./routers/auth.router";
import { listRouter } from "./routers/list.router";
import { searchRouter } from "./routers/search.router";
import { trendingRouter } from "./routers/trending.router";
import { watchProvidersRouter } from "./routers/watch-providers.router";

export const orpcRouter = {
  auth: authRouter,
  list: listRouter,
  search: searchRouter,
  trending: trendingRouter,
  watchProviders: watchProvidersRouter,
};

export const orpcHandler = new RPCHandler(orpcRouter, {
  plugins: [new RequestHeadersPlugin(), new ResponseHeadersPlugin()],
});
