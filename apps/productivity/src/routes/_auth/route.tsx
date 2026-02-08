import { safe } from "@orpc/client";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { orpc } from "@/orpc/orpc-client";

export const Route = createFileRoute("/_auth")({
  component: RouteComponent,
  beforeLoad: async () => {
    const [_, auth] = await safe(orpc.auth.getAuth.call());
    if (auth) {
      throw redirect({ to: "/" });
    }
  },
});

function RouteComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md">
        <Outlet />
      </div>
    </div>
  );
}
