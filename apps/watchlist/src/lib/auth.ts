import { randomInt } from "node:crypto";
import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { useSession } from "@tanstack/react-start/server";
import { addSeconds } from "date-fns";
import * as z from "zod";
import { getContext } from "./context";
import { db } from "./db";
import { emailSerice } from "./emails/emails";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 180; // 180 days

type SessionData = {
  sessionId: string;
};

function getAuthCookieSession() {
  const context = getContext();
  // biome-ignore lint/correctness/useHookAtTopLevel: not a hook
  return useSession<SessionData>({
    password: context.AUTH_SECRET,
    name: "session",
    cookie: {
      httpOnly: true,
      secure: context.MODE === "production",
      sameSite: "lax",
      maxAge: SESSION_MAX_AGE_SECONDS,
    },
  });
}

export const signUpWithMagicLink = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      email: z.email(),
    }),
  )
  .handler(async ({ data }) => {
    await db.deleteFrom("verification").where("target", "=", data.email).execute();

    const otp = randomInt(100000, 999999).toString();

    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const createdAt = new Date().toISOString();

    await db
      .insertInto("verification")
      .values({
        target: data.email,
        value: otp,
        expiresAt,
        createdAt,
      })
      .execute();

    const context = getContext();
    const magicLink = `${context.VITE_APP_URL}/magic-link-verify?email=${encodeURIComponent(data.email)}&code=${otp}`;

    await emailSerice.sendMagicLinkEmail({
      to: data.email,
      link: magicLink,
      code: otp,
    });

    return { success: true };
  });

export const verifyMagicLink = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      email: z.email(),
      code: z.string().length(6),
    }),
  )
  .handler(async ({ data }) => {
    const verification = await db
      .selectFrom("verification")
      .where("target", "=", data.email)
      .where("value", "=", data.code)
      .selectAll()
      .executeTakeFirst();

    if (!verification) {
      return { success: false, error: "Invalid verification code" };
    }

    if (new Date(verification.expiresAt) < new Date()) {
      await db.deleteFrom("verification").where("target", "=", data.email).where("value", "=", data.code).execute();
      return { success: false, error: "Verification code has expired" };
    }

    await db.deleteFrom("verification").where("target", "=", data.email).where("value", "=", data.code).execute();

    const now = new Date().toISOString();
    let user = await db.selectFrom("user").where("email", "=", data.email).selectAll().executeTakeFirst();

    if (!user) {
      const userId = crypto.randomUUID();
      await db
        .insertInto("user")
        .values({
          id: userId,
          name: data.email.split("@")[0],
          email: data.email,
          createdAt: now,
          updatedAt: now,
        })
        .execute();

      user = await db.selectFrom("user").where("id", "=", userId).selectAll().executeTakeFirstOrThrow();
    }

    const sessionId = crypto.randomUUID();
    await db
      .insertInto("session")
      .values({
        id: sessionId,
        createdAt: now,
        updatedAt: now,
        expiresAt: addSeconds(now, SESSION_MAX_AGE_SECONDS).toISOString(),
        userId: user.id,
      })
      .execute();

    const cookieSession = await getAuthCookieSession();
    await cookieSession.update({ sessionId });

    return { success: true, userId: user.id };
  });

export const getAuth = createServerFn({ method: "GET" }).handler(async () => {
  const session = await getAuthCookieSession();

  if (!session.data.sessionId) {
    return null;
  }

  const authSession = await db
    .selectFrom("session as s")
    .where("s.id", "=", session.data.sessionId)
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
    await session.clear();
    return null;
  }

  return authSession;
});

export const authenticatedMiddleware = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const auth = await getAuth();

  if (!auth) {
    throw redirect({ to: "/sign-in" });
  }

  return next({
    context: {
      auth,
    },
  });
});

export const signOut = createServerFn({ method: "POST" })
  .middleware([authenticatedMiddleware])
  .handler(async ({ context }) => {
    const session = await getAuthCookieSession();
    await db.deleteFrom("session").where("session.id", "=", context.auth.sessionId).execute();
    await session.clear();
    return { success: true };
  });
