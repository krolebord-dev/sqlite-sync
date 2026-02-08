import { randomInt } from "node:crypto";
import * as arctic from "arctic";
import { addSeconds } from "date-fns";
import * as z from "zod";
import { getContext } from "@/lib/context";
import { db } from "@/lib/db";
import { emailService } from "@/lib/emails/emails";
import { authCookieSession, createCookieSession } from "../common/auth";
import type { ORPCContext } from "../common/os";
import { procedure, protectedProcedure } from "../common/procedure";

type OAuthSessionData = {
  state: string;
  codeVerifier: string;
};

const oauthCookieSession = createCookieSession<OAuthSessionData>({
  name: "oauth",
  maxAge: 60 * 10, // 10 minutes for OAuth flow
});

function getGoogleProvider() {
  const context = getContext();
  return new arctic.Google(
    context.GOOGLE_CLIENT_ID,
    context.GOOGLE_CLIENT_SECRET,
    `${context.VITE_APP_URL}/api/auth/callback/google`,
  );
}

export const signUpWithMagicLink = procedure
  .input(
    z.object({
      email: z.email(),
    }),
  )
  .handler(async ({ input }) => {
    await db.deleteFrom("verification").where("target", "=", input.email).execute();

    const otp = randomInt(100000, 999999).toString();

    const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const createdAt = new Date().toISOString();

    await db
      .insertInto("verification")
      .values({
        target: input.email,
        value: otp,
        expiresAt,
        createdAt,
      })
      .execute();

    const context = getContext();
    const magicLink = `${context.VITE_APP_URL}/magic-link-verify?email=${encodeURIComponent(input.email)}&code=${otp}`;

    await emailService.sendMagicLinkEmail({
      to: input.email,
      link: magicLink,
      code: otp,
    });

    return { success: true };
  });

export const verifyMagicLink = procedure
  .input(
    z.object({
      email: z.email(),
      code: z.string().length(6),
    }),
  )
  .handler(async ({ input, context }) => {
    const verification = await db
      .selectFrom("verification")
      .where("target", "=", input.email)
      .where("value", "=", input.code)
      .selectAll()
      .executeTakeFirst();

    if (!verification) {
      return { success: false, error: "Invalid verification code" };
    }

    if (new Date(verification.expiresAt) < new Date()) {
      await db.deleteFrom("verification").where("target", "=", input.email).where("value", "=", input.code).execute();
      return { success: false, error: "Verification code has expired" };
    }

    await db.deleteFrom("verification").where("target", "=", input.email).where("value", "=", input.code).execute();

    const user = await findOrCreateUser({ email: input.email });
    await createSession(context, { userId: user.id });

    return { success: true, userId: user.id };
  });

export const getAuth = protectedProcedure.handler(async ({ context }) => {
  return context.auth;
});

export const signOut = protectedProcedure.handler(async ({ context }) => {
  await db.deleteFrom("session").where("session.id", "=", context.auth.sessionId).execute();
  await authCookieSession.clear(context);
  return { success: true };
});

export const initiateGoogleSignIn = procedure.handler(async ({ context }) => {
  const google = getGoogleProvider();
  const state = arctic.generateState();
  const codeVerifier = arctic.generateCodeVerifier();

  const scopes = ["openid", "profile", "email"];
  const url = google.createAuthorizationURL(state, codeVerifier, scopes);

  await oauthCookieSession.set(context, { state, codeVerifier });

  return { url: url.toString() };
});

const findOrCreateUser = async (data: { email: string; name?: string }) => {
  const now = new Date().toISOString();
  let user = await db.selectFrom("user").where("email", "=", data.email).selectAll().executeTakeFirst();

  if (!user) {
    const userId = crypto.randomUUID();
    await db
      .insertInto("user")
      .values({
        id: userId,
        name: data.name || data.email.split("@")[0],
        email: data.email,
        createdAt: now,
        updatedAt: now,
      })
      .execute();

    user = await db.selectFrom("user").where("id", "=", userId).selectAll().executeTakeFirstOrThrow();
  }

  return user;
};

const createSession = async (context: ORPCContext, data: { userId: string }) => {
  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();

  await db
    .insertInto("session")
    .values({
      id: sessionId,
      createdAt: now,
      updatedAt: now,
      expiresAt: addSeconds(now, authCookieSession.maxAge).toISOString(),
      userId: data.userId,
    })
    .execute();

  await authCookieSession.set(context, { sessionId });

  return sessionId;
};

export const handleGoogleCallback = async (context: ORPCContext, data: { code: string; state: string }) => {
  const oauthData = await oauthCookieSession.get(context);

  if (!oauthData?.state || oauthData?.state !== data.state) {
    await oauthCookieSession.clear(context);
    return { success: false, error: "Invalid OAuth state" };
  }

  const codeVerifier = oauthData?.codeVerifier;
  if (!codeVerifier) {
    await oauthCookieSession.clear(context);
    return { success: false, error: "Missing code verifier" };
  }

  await oauthCookieSession.clear(context);

  const google = getGoogleProvider();

  let tokens: arctic.OAuth2Tokens;
  try {
    tokens = await google.validateAuthorizationCode(data.code, codeVerifier);
  } catch (e) {
    if (e instanceof arctic.OAuth2RequestError) {
      return { success: false, error: "Invalid authorization code" };
    }
    return { success: false, error: "Failed to validate authorization code" };
  }

  const idToken = tokens.idToken();
  if (!idToken) {
    return { success: false, error: "No ID token received" };
  }

  const claims = arctic.decodeIdToken(idToken) as {
    sub: string;
    email?: string;
    name?: string;
    picture?: string;
  };

  if (!claims.email) {
    return { success: false, error: "No email in ID token" };
  }

  const user = await findOrCreateUser({ email: claims.email, name: claims.name });
  await createSession(context, { userId: user.id });

  return { success: true, userId: user.id };
};

export const authRouter = {
  signUpWithMagicLink,
  verifyMagicLink,
  getAuth,
  signOut,
  initiateGoogleSignIn,
};
