import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { isListWsRequest, routeListWsRequest } from './list/list-durable-object';
import { mainRouter } from './main/router';
import { createContext, createServices } from './main/trpc';

export default {
  async fetch(req, env, _ctx): Promise<Response> {
    const pathname = new URL(req.url).pathname;

    if (pathname.startsWith('/api')) {
      const services = await createServices({ env, req });
      return await fetchRequestHandler({
        endpoint: '/api/trpc',
        req,
        router: mainRouter,
        createContext: ({ req, resHeaders, info }) => createContext({ req, resHeaders, info, env, services }),
        onError({ error }) {
          console.error(error);
        },
        responseMeta({ ctx }) {
          if (!ctx) {
            return {};
          }
          return {
            headers: {
              'Server-Timing': ctx?.serverTimings.getSerializedTimings(),
            },
          };
        },
      });
    }

    const listId = await isListWsRequest(req);
    if (listId) {
      return await routeListWsRequest(listId, req, env);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;

export type { ListEvent } from './list/list-durable-object';
export { ListDurableObject } from './list/list-durable-object';
export type { MainRouter } from './main/router';
