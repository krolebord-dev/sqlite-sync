import { createId } from '@paralleldrive/cuid2';
import { initTRPC, TRPCError } from '@trpc/server';
import type { FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import superjson from 'superjson';
import { TMDB } from 'tmdb-ts';
import { z } from 'zod';
import { EmailService } from '../emails/emails';
import { broadcastListEvent, type ListEvent } from '../list/list-durable-object';
import { getSessionId, getValidUserSession } from '../utils/auth';
import { checkListAccess } from '../utils/list-access';
import { ServerTimings } from '../utils/server-timings';
import { createDb } from './db';

export async function createServices({ env, req }: { env: Env; req: Request }) {
  const serverTimings = new ServerTimings();
  const emailService = new EmailService(env.RESEND_API_KEY);
  const db = createDb(env);
  const tmdb = new TMDB(env.TMDB_READ_ACCESS_TOKEN);
  const time = <T>(name: string, fn: () => Promise<T>) => serverTimings.time(name, fn);

  const sessionId = getSessionId(req);
  const userSession = await time('getSession', async () =>
    sessionId ? await getValidUserSession(db, sessionId) : null,
  );

  const listEvents = {
    broadcast: (listId: string, event: ListEvent, options?: { except?: string[] }) =>
      broadcastListEvent(env.LIST_DO, listId, event, options),
  };

  return { serverTimings, emailService, db, tmdb, createId, time, userSession, listEvents };
}

export function createContext({
  req,
  resHeaders,
  info,
  env,
  services,
}: FetchCreateContextFnOptions & {
  env: Env;
  services: Awaited<ReturnType<typeof createServices>>;
}) {
  return { req, resHeaders, env, info, ...services };
}

export type Context = Awaited<ReturnType<typeof createContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure.use(async (opts) => {
  const path = opts.path;
  return await opts.ctx.time(path, () =>
    opts.next({
      ctx: {
        time: <T>(name: string, fn: () => Promise<T>) => opts.ctx.time(`${path}.${name}`, fn),
      },
    }),
  );
});

export const protectedProcedure = publicProcedure.use(async (opts) => {
  const userSession = opts.ctx.userSession;

  if (!userSession) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return opts.next({ ctx: { userSession } });
});

export const listProcedure = protectedProcedure.input(z.object({ listId: z.string() })).use(async (opts) => {
  const userId = opts.ctx.userSession.user.id;
  const listId = opts.input.listId;

  const hasAccess = await checkListAccess(opts.ctx.db, listId, userId);

  if (!hasAccess) {
    throw new TRPCError({ code: 'NOT_FOUND' });
  }

  return opts.next();
});
