import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";
import type { listDbOrpcRouter } from "./list-db-router";

type ListDbORPCClient = RouterClient<typeof listDbOrpcRouter>;
export type ListDbORPCUtils = RouterUtils<ListDbORPCClient>;

const clientCache = new Map<string, ListDbORPCUtils>();

export function getListDbOrpc(listId: string): ListDbORPCUtils {
  const cached = clientCache.get(listId);
  if (cached) {
    return cached;
  }

  const link = new RPCLink({
    url: () => `${import.meta.env.VITE_APP_URL}/list-db/list-db-server/list-${listId}/rpc`,
  });
  const client: ListDbORPCClient = createORPCClient(link);
  const utils = createTanstackQueryUtils(client);
  clientCache.set(listId, utils);
  return utils;
}
