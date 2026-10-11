import { getUserIdFromRequest, userCanAccessList } from "./auth-request";

export type Lobby = { className: string; name: string };

// Both routers can reach every Durable Object binding, so each route only admits its own class.
// ListDbServer rooms are `list-${listId}`; ChatAgent rooms are `list-${listId}:${conversationId}`.
export async function requireListAccess(
  request: Request,
  lobby: Lobby,
  className: "ListDbServer" | "ChatAgent",
): Promise<Response | undefined> {
  const match = /^list-([^:]+)(?::(.+))?$/.exec(lobby.name);
  const listId = match?.[1];
  const hasConversation = match?.[2] !== undefined;
  const roomMatchesClass = className === "ChatAgent" ? hasConversation : !hasConversation;
  if (lobby.className !== className || !listId || !roomMatchesClass) {
    return new Response("Not found", { status: 404 });
  }

  const userId = await getUserIdFromRequest(request);
  if (!userId || !(await userCanAccessList(userId, listId))) {
    return new Response("Unauthorized", { status: 401 });
  }
}
