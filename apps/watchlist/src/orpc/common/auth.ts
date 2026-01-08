import { deleteCookie, getCookie, setCookie, sign, unsign } from "@orpc/server/helpers";
import { getContext } from "@/lib/context";
import { db } from "@/lib/db";
import { type ORPCContext, osBase } from "./os";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

type SessionData = {
  sessionId: string;
};

export const authCookieSession = createCookieSession<SessionData>({
  name: "session",
  maxAge: SESSION_MAX_AGE_SECONDS,
});

export const authMiddleware = osBase.middleware(async ({ context, next, errors }) => {
  const session = await authCookieSession.get(context);

  if (!session?.sessionId) {
    throw errors.UNAUTHORIZED();
  }

  const authSession = await db
    .selectFrom("session as s")
    .where("s.id", "=", session.sessionId)
    .innerJoin("user as u", "s.userId", "u.id")
    .select([
      "u.id as userId",
      "s.id as sessionId",
      "u.name as userName",
      "u.email as userEmail",
      "s.expiresAt as sessionExpiresAt",
    ])
    .executeTakeFirst();

  if (!authSession || new Date(authSession.sessionExpiresAt) < new Date()) {
    await authCookieSession.clear(context);
    throw errors.UNAUTHORIZED();
  }

  return next({
    context: {
      auth: authSession,
    },
  });
});

export function createCookieSession<T>({ name, maxAge }: { name: string; maxAge: number }) {
  const env = getContext();

  const get = async (context: ORPCContext) => {
    const headers = context.reqHeaders;
    if (!headers) {
      return null;
    }
    const cookie = getCookie(headers, name);
    if (!cookie) {
      return null;
    }
    const payload = await unsign(cookie, env.AUTH_SECRET);
    if (!payload) {
      return null;
    }
    return JSON.parse(payload) as T;
  };

  const set = async (context: ORPCContext, value: T) => {
    const headers = context.resHeaders;
    if (!headers) {
      return;
    }
    const payload = await sign(JSON.stringify(value), env.AUTH_SECRET);
    setCookie(headers, name, payload, {
      httpOnly: true,
      secure: env.MODE === "production",
      sameSite: "lax",
      maxAge,
    });
  };

  const clear = async (context: ORPCContext) => {
    const headers = context.resHeaders;
    if (!headers) {
      return;
    }
    deleteCookie(headers, name);
  };

  return { get, set, clear, name, maxAge };
}
