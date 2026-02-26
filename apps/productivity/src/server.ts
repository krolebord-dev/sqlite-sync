import { getCookie, unsign } from "@orpc/server/helpers";
import { routePartykitRequest } from "partyserver";
import { apiHandler } from "./api/api-handler";
import { orpcHandler } from "./orpc/orpc-router";

async function getUserIdFromRequest(request: Request, env: Env): Promise<string | null> {
  const cookie = getCookie(request.headers, "session");
  if (!cookie) return null;

  const payload = await unsign(cookie, env.AUTH_SECRET);
  if (!payload) return null;

  const { sessionId } = JSON.parse(payload) as { sessionId: string };
  if (!sessionId) return null;

  const session = await env.MAIN_DB.prepare("SELECT userId, expiresAt FROM session WHERE id = ?")
    .bind(sessionId)
    .first<{ userId: string; expiresAt: string }>();

  if (!session || new Date(session.expiresAt) < new Date()) return null;

  return session.userId;
}

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
      onBeforeConnect: async (req, lobby) => {
        const userId = await getUserIdFromRequest(req, env);
        if (!userId || lobby.name !== `user-${userId}`) {
          return new Response("Unauthorized", { status: 401 });
        }
      },
    });
    if (partykitRequest) {
      return partykitRequest;
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

export { UserDbServer } from "./user-db/user-db-server";
