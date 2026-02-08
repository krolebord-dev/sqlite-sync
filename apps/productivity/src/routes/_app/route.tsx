import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { orpc } from "@/orpc/orpc-client";

export const Route = createFileRoute("/_app")({
  component: RouteComponent,
  loader: async ({ context }) => {
    const auth = await context.queryClient.ensureQueryData(orpc.auth.getAuth.queryOptions());

    if (!auth) {
      throw redirect({ to: "/sign-in" });
    }

    return { auth };
  },
  staleTime: 1000 * 60 * 5,
});

function RouteComponent() {
  return <Outlet />;
}
