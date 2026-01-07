import { createFileRoute, useLoaderData } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppHeader, ProjectSelector } from "@/components/app-layout";
import { userCanAccessListMiddleware } from "@/lib/lists";

const getList = createServerFn({ method: "GET" })
  .middleware([userCanAccessListMiddleware])
  .handler(async ({ context }) => {
    return context.list;
  });

export const Route = createFileRoute("/_app/list/$id")({
  component: RouteComponent,
  loaderDeps: () => ({}),
  shouldReload: false,
  loader: async ({ params }) => {
    const list = await getList({ data: { listId: params.id } });
    return { list };
  },
});

function RouteComponent() {
  const { list } = useLoaderData({ from: "/_app/list/$id" });
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
