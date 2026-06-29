import { routeAgentRequest } from "agents";
import { routePartykitRequest } from "partyserver";
import { apiHandler } from "./api/api-handler";
import { getUserIdFromRequest, userCanAccessList } from "./lib/auth-request";
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
      // ChatAgent instances are named `list-${listId}:${conversationId}`. Only members of that
      // list may reach the agent for it.
      const guard = async (req: Request, lobby: { name: string }) => {
        const userId = await getUserIdFromRequest(req);
        const listId = lobby.name.startsWith("list-") ? lobby.name.slice("list-".length).split(":")[0] : null;
        if (!userId || !listId || !(await userCanAccessList(userId, listId))) {
          return new Response("Unauthorized", { status: 401 });
        }
      };

      const agentResponse = await routeAgentRequest(request, env, {
        locationHint: "weur",
        onBeforeConnect: (req, lobby) => guard(req, lobby),
        onBeforeRequest: (req, lobby) => guard(req, lobby),
      });
      if (agentResponse) {
        return agentResponse;
      }

      return new Response("Not found", { status: 404 });
    }

    const partykitRequest = await routePartykitRequest(request, env, {
      prefix: "list-db",
      locationHint: "weur",
    });
    if (partykitRequest) {
      return partykitRequest;
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { ChatAgent } from "./agent/chat-agent";
export { ListDbServer } from "./list-db/list-db-server";
