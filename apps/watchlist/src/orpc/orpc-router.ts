import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, ResponseHeadersPlugin } from "@orpc/server/plugins";
import { authRouter } from "./routers/auth.router";
import { listRouter } from "./routers/list.router";

export const orpcRouter = {
  auth: authRouter,
  list: listRouter,
};

export const orpcHandler = new RPCHandler(orpcRouter, {
  plugins: [new RequestHeadersPlugin(), new ResponseHeadersPlugin()],
});
