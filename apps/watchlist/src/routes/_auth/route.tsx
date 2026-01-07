import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getAuth } from "@/lib/auth";

export const Route = createFileRoute("/_auth")({
  component: RouteComponent,
  beforeLoad: async () => {
    const auth = await getAuth();
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
