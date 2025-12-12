import { parse } from 'cookie';
import { and, eq, gt } from 'drizzle-orm';
import type { MainDb } from '../main/db';

export const sessionCookieName = 'session';

export function getSessionId(request: Request) {
  const cookie = request.headers.get('Cookie');
  if (!cookie) {
    return null;
  }
  const parsed = parse(cookie);
  return parsed[sessionCookieName] ?? null;
}

export async function getValidUserSession(db: MainDb, sessionId: string) {
  const session = await db.query.sessionsTable.findFirst({
    where: (f) => and(eq(f.id, sessionId), gt(f.validUntil, new Date())),
    columns: {
      id: true,
      validUntil: true,
      createdAt: true,
    },
    with: {
      user: {
        columns: {
          id: true,
          name: true,
          email: true,
        },
      },
    },
  });

  return session ?? null;
}

export type UserSession = Exclude<Awaited<ReturnType<typeof getValidUserSession>>, null>;
