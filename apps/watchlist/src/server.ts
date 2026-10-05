import { routeAgentRequest } from "agents";
import { routePartykitRequest } from "partyserver";
import { apiHandler } from "./api/api-handler";
import { type Lobby, requireListAccess } from "./lib/list-access-guard";
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

    if (url.pathname.startsWith("/agents")) {
      const guard = (req: Request, lobby: Lobby) => requireListAccess(req, lobby, "chat-agent");
      const agentResponse = await routeAgentRequest(request, env, {
        locationHint: "weur",
        onBeforeConnect: guard,
        onBeforeRequest: guard,
      });
      if (agentResponse) {
        return agentResponse;
      }

      return new Response("Not found", { status: 404 });
    }

    const guard = (req: Request, lobby: Lobby) => requireListAccess(req, lobby, "list-db-server");
    const partykitRequest = await routePartykitRequest(request, env, {
      prefix: "list-db",
      locationHint: "weur",
      onBeforeConnect: guard,
      onBeforeRequest: guard,
    });
    if (partykitRequest) {
      return partykitRequest;
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { ChatAgent } from "./agent/chat-agent";
export { ListDbServer } from "./list-db/list-db-server";
