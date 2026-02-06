import type { SyncedDb } from "@sqlite-sync/core";
import { createFileRoute, Outlet, useLoaderData } from "@tanstack/react-router";
import { DbProvider, initListDb } from "@/list-db/list-db";
import { ListDbOrpcProvider } from "@/list-db/list-orpc-context";
import type { ListDb } from "@/list-db/migrations";
import { orpc } from "@/orpc/orpc-client";

const dbs = new Map<string, SyncedDb<ListDb>>();

export const Route = createFileRoute("/_app/list/$id")({
  component: ListLayoutComponent,
  shouldReload: false,
  loader: async ({ params, context }) => {
    const list = await context.queryClient.ensureQueryData(
      orpc.list.getList.queryOptions({ input: { listId: params.id } }),
    );

    let db = dbs.get(list.id);
    if (!db) {
      db = await initListDb({ listId: list.id });
      dbs.set(list.id, db);
    }
    return { list, db };
  },
});

function ListLayoutComponent() {
  const { db, list } = useLoaderData({ from: "/_app/list/$id" });

  return (
    <DbProvider db={db}>
      <ListDbOrpcProvider listId={list.id}>
        <Outlet />
      </ListDbOrpcProvider>
    </DbProvider>
  );
}
