import type { SyncedDb } from "@sqlite-sync/core";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { AppHeader, ProjectSelector } from "@/components/app-layout";
import { initListDb } from "@/lib/list-db/list-db";
import type { ListDb } from "@/lib/list-db/migrations";
import { orpc } from "@/orpc/orpc-client";

let db: SyncedDb<ListDb> | null = null;

export const Route = createFileRoute("/_app/list/$id")({
  component: RouteComponent,
  loaderDeps: () => ({}),
  shouldReload: false,
  loader: async ({ params, context }) => {
    const list = await context.queryClient.ensureQueryData(
      orpc.list.getList.queryOptions({ input: { listId: params.id } }),
    );
    if (!db) {
      db = await initListDb({ listId: list.id });
    }
    return { list };
  },
});

function RouteComponent() {
  return (
    <>
      <AppHeader>
        <div className="flex items-center gap-2">
          <ProjectSelector />
          {/* <ListSettings /> */}
        </div>
        {/* <ListUsers /> */}
      </AppHeader>
      {/* <AddItemButton /> */}
      <div className="sticky top-0 z-10 flex items-center justify-center bg-background/80 pb-2 backdrop-blur-md">
        <div className="grid w-full max-w-7xl grid-cols-[1fr_auto] items-center justify-start gap-x-4 gap-y-1 px-4 pt-2 sm:grid-cols-[auto_1fr_auto]">
          {/* <SortingHeader />
          <SearchInput className="max-sm:col-span-2 max-sm:row-start-2 sm:max-w-52" />
          <HeaderMenu /> */}
        </div>
      </div>
      <div className="flex w-full flex-col items-center">{/* <ItemsList /> */}</div>
    </>
  );
}
