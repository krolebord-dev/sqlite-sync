import { getCookie, unsign } from "@orpc/server/helpers";
import { getContext } from "@/lib/context";
import { db } from "@/lib/db";

type SessionData = {
  sessionId: string;
};

// Resolves the signed `session` cookie on a raw Request to a user id, mirroring the oRPC
// auth middleware but usable in the bare fetch handler (e.g. the /agents/* guard).
export async function getUserIdFromRequest(request: Request): Promise<string | null> {
  const env = getContext();
  const cookie = getCookie(request.headers, "session");
  if (!cookie) {
    return null;
  }
  const payload = await unsign(cookie, env.AUTH_SECRET);
  if (!payload) {
    return null;
  }
  const { sessionId } = JSON.parse(payload) as SessionData;
  if (!sessionId) {
    return null;
  }

  const session = await db
    .selectFrom("session as s")
    .where("s.id", "=", sessionId)
    .innerJoin("user as u", "s.userId", "u.id")
    .select(["u.id as userId", "s.expiresAt as sessionExpiresAt"])
    .executeTakeFirst();

  if (!session || new Date(session.sessionExpiresAt) < new Date()) {
    return null;
  }
  return session.userId;
}

export async function userCanAccessList(userId: string, listId: string): Promise<boolean> {
  const row = await db
    .selectFrom("user_to_list")
    .where("userId", "=", userId)
    .where("listId", "=", listId)
    .select("listId")
    .executeTakeFirst();
  return Boolean(row);
}
