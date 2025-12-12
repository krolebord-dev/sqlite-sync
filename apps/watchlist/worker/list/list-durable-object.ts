import { type Connection, type ConnectionContext, getServerByName, Server } from 'partyserver';
import * as R from 'remeda';
import superjson from 'superjson';
import { createDb } from '../main/db';
import { getValidUserSession } from '../utils/auth';
import { checkListAccess } from '../utils/list-access';

export async function isListWsRequest(request: Request) {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/ws/list/')) {
    return false;
  }

  const listId = url.pathname.split('/')[3];

  if (!listId) {
    return false;
  }

  return listId;
}

export async function routeListWsRequest(listId: string, request: Request, env: Env) {
  const db = createDb(env);

  const sessionId = new URL(request.url).searchParams.get('sessionId');
  const userSession = sessionId ? await getValidUserSession(db, sessionId) : null;
  const user = userSession?.user;

  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const hasAccess = await checkListAccess(db, listId, user.id);

  if (!hasAccess) {
    return new Response('Forbidden', { status: 403 });
  }

  const server = await getServerByName(env.LIST_DO, listId);

  if (!server) {
    return new Response('Not Found', { status: 404 });
  }

  const req = new Request(request);
  req.headers.set('x-partykit-room', listId);
  req.headers.set('x-partykit-namespace', 'list');
  req.headers.set('x-user', JSON.stringify(user));
  req.headers.set('x-internal-request', 'false');

  return await server.fetch(req);
}

type BroadcastPayload = {
  event: ListEvent;
  except?: string[];
};

export async function broadcastListEvent(
  namespace: DurableObjectNamespace<ListDurableObject>,
  listId: string,
  event: ListEvent,
  options?: { except?: string[] },
) {
  const server = await getServerByName(namespace, listId);

  if (!server) {
    return;
  }

  const req = new Request('https://krolebord.com/broadcast-list-event', {
    headers: {
      'x-partykit-room': listId,
      'x-partykit-namespace': 'list',
      'x-internal-request': 'true',
      'content-type': 'application/json',
    },
    method: 'POST',
    body: superjson.stringify({
      event,
      except: options?.except,
    } as BroadcastPayload),
  });

  return await server.fetch(req);
}

type UserInfo = {
  id: string;
  name: string;
  email: string;
};

type ConnectionState = {
  user: UserInfo;
};

type Item = {
  id: string;
  type: 'movie' | 'tv';
  tmdbId: number | null;
  title: string;
  overview: string | null;
  duration: number | null;
  episodeCount: number | null;
  rating: number | null;
  releaseDate: Date | null;
  posterUrl: string | null;
  watchedAt: Date | null;
  priority: number;
  createdAt: Date;
};

export type ListEvent =
  | {
      type: 'users-updated';
      users: {
        id: string;
        name: string;
      }[];
    }
  | {
      type: 'item-created';
      item: Item;
    }
  | {
      type: 'item-removed';
      itemId: string;
    }
  | {
      type: 'item-updated';
      item: Item;
    };

export class ListDurableObject extends Server<Env> {
  async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext): Promise<void> {
    const user = JSON.parse(ctx.request.headers.get('x-user') ?? 'null') as UserInfo;
    if (!user) {
      console.error('user not found');
      connection.close();
    }

    connection.setState({ user });

    this.broadcastCurrentUsers();
  }

  onClose(_connection: Connection<ConnectionState>): void | Promise<void> {
    this.broadcastCurrentUsers();
  }

  async onRequest(request: Request): Promise<Response> {
    if (
      request.headers.get('x-internal-request') !== 'true' ||
      !new URL(request.url).pathname.startsWith('/broadcast-list-event') ||
      request.method !== 'POST'
    ) {
      return super.onRequest(request);
    }

    const body = superjson.deserialize(await request.json());
    const { event, except } = body as BroadcastPayload;
    this.broadcastEvent(event, { except });

    return new Response('OK');
  }

  broadcastCurrentUsers() {
    const users = R.pipe(
      [...this.getConnections<ConnectionState>()],
      R.map((x) => x.state?.user),
      R.filter((x) => !!x),
      R.uniqueBy((x) => x.id),
      R.map((x) => ({
        id: x.id,
        name: x.name,
      })),
    );
    this.broadcastEvent({ type: 'users-updated', users });
  }

  broadcastEvent(event: ListEvent, options?: { except?: string[] }) {
    const without = options?.except
      ? R.pipe(
          [...this.getConnections<ConnectionState>()],
          R.filter((x) => !!options.except?.includes(x.state?.user.id ?? '')),
          R.uniqueBy((x) => x.id),
          R.map((x) => x.id),
        )
      : [];

    this.broadcast(superjson.stringify(event), without);
  }
}
