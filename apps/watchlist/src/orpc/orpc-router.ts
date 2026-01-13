import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, ResponseHeadersPlugin } from "@orpc/server/plugins";
import { authRouter } from "./routers/auth.router";
import { listRouter } from "./routers/list.router";
import { searchRouter } from "./routers/search.router";

export const orpcRouter = {
  auth: authRouter,
  list: listRouter,
  search: searchRouter,
};

export const orpcHandler = new RPCHandler(orpcRouter, {
  plugins: [new RequestHeadersPlugin(), new ResponseHeadersPlugin()],
});
