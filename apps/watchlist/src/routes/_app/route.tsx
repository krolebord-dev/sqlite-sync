import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app")({
  component: RouteComponent,
  beforeLoad: async () => {
    const auth = await getAuth();

    if (!auth) {
      throw redirect({ to: "/sign-in" });
    }

    return { auth };
  },
});

function RouteComponent() {
  return (
    <div>
      route
      <Outlet />
    </div>
  );
}
