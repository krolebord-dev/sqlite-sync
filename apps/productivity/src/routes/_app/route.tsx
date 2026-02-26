import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { orpc } from "@/orpc/orpc-client";
import { DbProvider, initUserDb } from "@/user-db/user-db";

let cachedDb: { userId: string; db: Awaited<ReturnType<typeof initUserDb>> } | null = null;

export const Route = createFileRoute("/_app")({
  component: RouteComponent,
  shouldReload: false,
  loader: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(orpc.auth.getAuth.queryOptions());

    if (!auth) {
      throw redirect({ to: "/sign-in" });
    }

    if (!cachedDb || cachedDb.userId !== auth.userId) {
      const db = await initUserDb({ userId: auth.userId });
      cachedDb = { userId: auth.userId, db };
    }

    return { auth, db: cachedDb.db };
  },
  staleTime: 1000 * 60 * 5,
});

function RouteComponent() {
  const { db } = Route.useLoaderData();
  return (
    <DbProvider db={db}>
      <Outlet />
    </DbProvider>
  );
}
