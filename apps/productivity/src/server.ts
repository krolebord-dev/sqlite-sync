import { routePartykitRequest } from "partyserver";
import { apiHandler } from "./api/api-handler";
import { orpcHandler } from "./orpc/orpc-router";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/rpc")) {
      const { matched, response } = await orpcHandler.handle(request, {
        prefix: "/rpc",
        context: {},
      });

      if (matched) {
        return response;
      }

      return new Response("Not found", { status: 404 });
    }

    if (url.pathname.startsWith("/api")) {
      return apiHandler(request);
    }

    const partykitRequest = await routePartykitRequest(request, env, {
      prefix: "user-db",
      locationHint: "weur",
    });
    if (partykitRequest) {
      return partykitRequest;
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { UserDbServer } from "./user-db/user-db-server";
