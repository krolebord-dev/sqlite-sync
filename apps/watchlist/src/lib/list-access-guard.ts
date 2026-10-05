import { getUserIdFromRequest, userCanAccessList } from "./auth-request";

export type Lobby = { party: string; name: string };

// Both routers can reach every Durable Object binding, so each route only admits its own party.
// ListDbServer rooms are `list-${listId}`; ChatAgent rooms are `list-${listId}:${conversationId}`.
export async function requireListAccess(
  request: Request,
  lobby: Lobby,
  party: "list-db-server" | "chat-agent",
): Promise<Response | undefined> {
  const match = /^list-([^:]+)(?::(.+))?$/.exec(lobby.name);
  const listId = match?.[1];
  const hasConversation = match?.[2] !== undefined;
  const roomMatchesParty = party === "chat-agent" ? hasConversation : !hasConversation;
  if (lobby.party !== party || !listId || !roomMatchesParty) {
    return new Response("Not found", { status: 404 });
  }

  const userId = await getUserIdFromRequest(request);
  if (!userId || !(await userCanAccessList(userId, listId))) {
    return new Response("Unauthorized", { status: 401 });
  }
}
