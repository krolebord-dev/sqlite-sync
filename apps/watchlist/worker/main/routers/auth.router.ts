import { generateTOTP } from '@oslojs/otp';
import { createId } from '@paralleldrive/cuid2';
import { serialize } from 'cookie';
import { addSeconds } from 'date-fns';
import { secondsInDay, secondsInHour } from 'date-fns/constants';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { sessionCookieName } from '../../utils/auth';
import { type MainDb, mainSchema } from '../db';
import { type Context, publicProcedure, router } from '../trpc';

const verificationTTLInSeconds = secondsInHour * 24;

const sessionTTLInSeconds = secondsInDay * 30 * 12;

export const authRouter = router({
  sendMagicLink: publicProcedure.input(z.object({ email: z.string().email() })).mutation(async ({ input, ctx }) => {
    const { email } = input;

    return await sendMagicLinkEmail(ctx, { email });
  }),

  useMagicLink: publicProcedure
    .input(z.object({ email: z.string().email(), token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { db } = ctx;
      const { email, token } = input;

      const [verification, user] = await Promise.all([
        findValidEmailVerification({ ctx, email, token }),
        db.query.usersTable.findFirst({
          columns: {
            id: true,
          },
          where: (f) => eq(f.email, email),
        }),
      ]);

      if (!verification) {
        return { status: 'invalid-token' as const };
      }

      if (!user) {
        return { status: 'user-not-found' as const };
      }

      const sessionId = createId();
      await db.batch([markVerificationAsUsed(db, verification.id), createUserSession(db, user.id, sessionId)]);

      setSessionCookie(ctx, sessionId);

      if (verification.list?.id) {
        await db
          .insert(mainSchema.usersToListsTable)
          .values({
            userId: user.id,
            listId: verification.list.id,
          })
          .onConflictDoNothing();

        return { status: 'success' as const, listId: verification.list.id };
      }

      return { status: 'success' as const };
    }),

  register: publicProcedure
    .input(z.object({ email: z.string().email(), name: z.string().min(2), token: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { db } = ctx;
      const { email, name, token } = input;

      const [verification, user] = await Promise.all([
        findValidEmailVerification({ ctx, email, token }),
        db.query.usersTable.findFirst({
          columns: {
            id: true,
          },
          where: (f) => eq(f.email, email),
        }),
      ]);

      if (!verification) {
        return { status: 'invalid-token' as const };
      }

      if (user) {
        return { status: 'user-already-exists' as const };
      }

      const userId = createId();
      const sessionId = createId();

      await db.batch([
        db.insert(mainSchema.usersTable).values({
          id: userId,
          name,
          email,
        }),
        markVerificationAsUsed(db, verification.id),
        createUserSession(db, userId, sessionId),
      ]);

      setSessionCookie(ctx, sessionId);

      if (verification.list?.id) {
        await db
          .insert(mainSchema.usersToListsTable)
          .values({
            userId,
            listId: verification.list.id,
          })
          .onConflictDoNothing();

        return { status: 'success' as const, listId: verification.list.id };
      }

      return { status: 'success' as const };
    }),

  getUser: publicProcedure.query(({ ctx }) => {
    const session = ctx.userSession;

    if (!session) {
      return null;
    }

    return {
      ...session.user,
      sessionId: session.id,
    };
  }),

  logout: publicProcedure.mutation(({ ctx }) => {
    setSessionCookie(ctx, '');
    return { status: 'success' as const };
  }),
});

async function findValidEmailVerification({ ctx, email, token }: { ctx: Context; email: string; token: string }) {
  const { db } = ctx;
  return await db.query.verificationsTable.findFirst({
    where: (f) =>
      and(
        eq(f.target, email),
        eq(f.targetType, 'email'),
        eq(f.isValid, true),
        eq(f.token, token),
        gt(f.expiredAt, new Date()),
        isNull(f.usedAt),
      ),
    with: {
      list: {
        columns: {
          id: true,
        },
      },
    },
  });
}

function markVerificationAsUsed(db: MainDb, verificationId: string) {
  return db
    .update(mainSchema.verificationsTable)
    .set({ usedAt: new Date() })
    .where(eq(mainSchema.verificationsTable.id, verificationId));
}

function createUserSession(db: MainDb, userId: string, sessionId: string) {
  return db.insert(mainSchema.sessionsTable).values({
    id: sessionId,
    userId,
    validUntil: addSeconds(new Date(), sessionTTLInSeconds),
  });
}

function setSessionCookie(ctx: Context, sessionId: string) {
  ctx.resHeaders.set(
    'Set-Cookie',
    serialize(sessionCookieName, sessionId, {
      path: '/api',
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.env.MODE === 'production',
      maxAge: sessionTTLInSeconds,
    }),
  );
}

type MagicLinkOptions = {
  email: string;
  listId?: string;
};

export async function sendMagicLinkEmail(ctx: Context, { email, listId }: MagicLinkOptions) {
  const secret = new Uint8Array(20);
  crypto.getRandomValues(secret);
  const verificationCode = generateTOTP(secret, verificationTTLInSeconds, 6);

  await ctx.db.insert(mainSchema.verificationsTable).values({
    id: createId(),
    targetType: 'email',
    target: email,
    listId,
    token: verificationCode,
    expiredAt: addSeconds(new Date(), verificationTTLInSeconds),
  });

  const result = await ctx.emailService.sendMagicLinkEmail({
    to: email,
    code: verificationCode,
    link: `${ctx.env.APP_URL}/auth/magic-link?email=${email}&token=${verificationCode}`,
  });

  if (ctx.env.MODE !== 'production') {
    console.log('Magic link sent to', email, verificationCode);
  }

  return result;
}
