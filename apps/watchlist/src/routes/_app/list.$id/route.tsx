import type { SyncedDb } from "@sqlite-sync/core";
import { createFileRoute, Outlet, useLoaderData } from "@tanstack/react-router";
import { lastOpenedList } from "@/lib/utils/last-opened-list";
import { DbProvider, initListDb } from "@/list-db/list-db";
import { ListDbOrpcProvider } from "@/list-db/list-orpc-context";
import type { ListDb } from "@/list-db/migrations";
import { orpc } from "@/orpc/orpc-client";
import { ListChat } from "./-/list-chat";
import { SyncStatusMonitor } from "./-/sync-status-monitor";

const dbs = new Map<string, SyncedDb<ListDb>>();

export const Route = createFileRoute("/_app/list/$id")({
  component: ListLayoutComponent,
  shouldReload: false,
  loader: async ({ params, context }) => {
    lastOpenedList.set(params.id);

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
      <SyncStatusMonitor />
      <ListDbOrpcProvider listId={list.id}>
        <Outlet />
        <ListChat listId={list.id} />
      </ListDbOrpcProvider>
    </DbProvider>
  );
}
