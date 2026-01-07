import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app")({
  component: RouteComponent,
  loader: async () => {
    const auth = await getAuth();

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
