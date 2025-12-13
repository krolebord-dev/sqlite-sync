import { type Connection, type ConnectionContext, getServerByName, Server } from 'partyserver';
import type { Compilable, Kysely } from 'kysely';
import {
  dummyKysely,
  crdtSchema,
  syncServerRequestSchema,
  createCrdtStorage,
  createSyncIdCounter,
  createCrdtSyncProducer,
  jsonSafeParse,
  type PersistedCrdtEvent,
  type SyncServerMessage,
  type SyncServerRequest,
  type ExtractSyncServerRequest,
  type CrdtStorage,
} from '@sqlite-sync/core/server';
import * as R from 'remeda';
import { createDb } from '../main/db';
import { getValidUserSession } from '../utils/auth';
import { checkListAccess } from '../utils/list-access';

// Helper types for SQL execution
type ExecuteParams = {
  sql: string;
  parameters: readonly unknown[];
};

type ExecuteResult<T> = {
  rows: T[];
};

type QueryBuilderOutput<QB> = QB extends Compilable<infer O> ? O : never;

type KyselyQueryFactory<TDatabase, TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>> = (
  kysely: Kysely<TDatabase>,
) => TQuery;

function createKyselyExecutor<TDatabase>(db: SqlStorage) {
  return {
    execute<TResult = unknown>(query: ExecuteParams): ExecuteResult<TResult> {
      const rows = db.exec(query.sql, ...query.parameters).toArray();
      return { rows: rows as TResult[] };
    },
    executeKysely<TQuery extends Compilable<TResult>, TResult = QueryBuilderOutput<TQuery>>(
      factory: KyselyQueryFactory<TDatabase, TQuery, TResult>,
    ): ExecuteResult<TResult> {
      const query = factory(dummyKysely).compile();
      return this.execute(query);
    },
  };
}

type SqlExecutor<TDatabase> = ReturnType<typeof createKyselyExecutor<TDatabase>>;

type EventLogDbSchema = {
  crdt_events: PersistedCrdtEvent;
};

const batchSize = 50;

// User info for connection tracking
type UserInfo = {
  id: string;
  name: string;
  email: string;
};

type ConnectionState = {
  user: UserInfo;
};

// Users presence event (still sent via the sync protocol)
export type UsersUpdatedEvent = {
  type: 'users-updated';
  users: { id: string; name: string }[];
};

/**
 * Check if the request is for the list sync WebSocket endpoint
 */
export async function isListSyncWsRequest(request: Request) {
  const url = new URL(request.url);

  if (!url.pathname.startsWith('/ws/list-sync/')) {
    return false;
  }

  const listId = url.pathname.split('/')[3];

  if (!listId) {
    return false;
  }

  return listId;
}

/**
 * Route the WebSocket request to the appropriate List Sync Server
 */
export async function routeListSyncWsRequest(listId: string, request: Request, env: Env) {
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

  const server = await getServerByName(env.LIST_SYNC_DO, listId);

  if (!server) {
    return new Response('Not Found', { status: 404 });
  }

  const req = new Request(request);
  req.headers.set('x-partykit-room', listId);
  req.headers.set('x-partykit-namespace', 'list-sync');
  req.headers.set('x-user', JSON.stringify(user));

  return await server.fetch(req);
}

/**
 * List Sync Server - CRDT-based sync server for list items
 * Handles:
 * - CRDT event storage and synchronization
 * - User presence tracking
 */
export class ListSyncServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  private sqlExecutor: SqlExecutor<EventLogDbSchema> = null!;
  private storage: CrdtStorage = null!;

  onStart(): void | Promise<void> {
    this.sqlExecutor = createKyselyExecutor(this.ctx.storage.sql);

    // Create the CRDT events table
    this.sqlExecutor.executeKysely((db) => crdtSchema.persistedEventsTable(db.schema, 'crdt_events'));

    const syncId = createSyncIdCounter({
      initialSyncId: this.getLatestSyncId(),
    });

    this.storage = createCrdtStorage({
      syncId,
      applyCrdtEventMutations: () => {},
      persistEvents: (events) => {
        this.ctx.storage.transactionSync(() => {
          for (const event of events) {
            this.sqlExecutor.executeKysely((db) => db.insertInto('crdt_events').values(event));
          }
        });
      },
      popPendingEventsBatch: () => {
        const events = this.sqlExecutor.executeKysely((db) =>
          db.selectFrom('crdt_events').where('status', '=', 'pending').orderBy('sync_id', 'asc').limit(batchSize).selectAll(),
        ).rows;
        return {
          events,
          hasMore: events.length === batchSize,
        };
      },
      updateEventStatus: (syncId, status) =>
        this.sqlExecutor.executeKysely((db) =>
          db.updateTable('crdt_events').set({ status }).where('sync_id', '=', syncId),
        ),
    });

    createCrdtSyncProducer({
      bufferSize: 50,
      storage: this.storage,
      broadcastEvents: (chunk) => {
        this.broadcast(
          JSON.stringify({
            type: 'events-applied',
            newSyncId: chunk.newSyncId,
          } satisfies SyncServerMessage),
        );
      },
    });
  }

  async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext): Promise<void> {
    const user = JSON.parse(ctx.request.headers.get('x-user') ?? 'null') as UserInfo;
    if (!user) {
      console.error('user not found');
      connection.close();
      return;
    }

    connection.setState({ user });

    // Broadcast user presence update
    this.broadcastCurrentUsers();
  }

  onClose(_connection: Connection<ConnectionState>): void | Promise<void> {
    // Broadcast user presence update when someone disconnects
    this.broadcastCurrentUsers();
  }

  onMessage(connection: Connection<ConnectionState>, message: string) {
    const requestRaw = jsonSafeParse<SyncServerRequest>(message);

    if (requestRaw.status !== 'ok') {
      console.log('Invalid request', requestRaw.error);
      return;
    }

    const requestResult = syncServerRequestSchema.safeParse(requestRaw.data);

    if (!requestResult.success) {
      console.log('Invalid request', requestResult.error);
      return;
    }

    const request = requestResult.data;

    switch (request.type) {
      case 'pull-events':
        this.handlePullEvents(connection, request);
        break;
      case 'push-events':
        this.handlePushEvents(connection, request);
        break;
      default:
        request satisfies never;
        return;
    }
  }

  private handlePullEvents(connection: Connection<ConnectionState>, request: ExtractSyncServerRequest<'pull-events'>) {
    const events = this.sqlExecutor.executeKysely((db) => {
      const query = db
        .selectFrom('crdt_events')
        .where('sync_id', '>', request.afterSyncId)
        .where('status', '=', 'applied')
        .orderBy('sync_id', 'asc')
        .limit(batchSize)
        .selectAll();
      return query;
    }).rows;

    const eventsPullMessage: SyncServerMessage = {
      type: 'events-pull-response',
      requestId: request.requestId,
      data: {
        events: request.excludeNodeId ? events.filter((x) => x.origin !== request.excludeNodeId) : events,
        hasMore: events.length === batchSize,
        newSyncId: events[events.length - 1]?.sync_id ?? request.afterSyncId,
      },
    };

    connection.send(JSON.stringify(eventsPullMessage));
  }

  private handlePushEvents(connection: Connection<ConnectionState>, request: ExtractSyncServerRequest<'push-events'>) {
    this.storage.enqueueEvents(request.events.map((x) => ({ ...x, origin: request.nodeId })));

    const eventsAppliedMessage: SyncServerMessage = {
      type: 'events-push-response',
      requestId: request.requestId,
      data: {
        ok: true,
      },
    };

    connection.send(JSON.stringify(eventsAppliedMessage));
  }

  private getLatestSyncId() {
    const result = this.sqlExecutor.executeKysely((db) =>
      db.selectFrom('crdt_events').select((eb) => eb.fn.max('sync_id').as('sync_id')),
    );
    return result.rows[0]?.sync_id ?? 0;
  }

  /**
   * Broadcast current connected users to all clients
   */
  private broadcastCurrentUsers() {
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

    // Send as a special message (clients can handle this alongside CRDT events)
    const message: UsersUpdatedEvent = { type: 'users-updated', users };
    this.broadcast(JSON.stringify(message));
  }
}

