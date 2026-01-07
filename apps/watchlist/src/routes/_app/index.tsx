import { createFileRoute } from "@tanstack/react-router";
import { useAuth, useSignOut } from "@/lib/auth-client";

export const Route = createFileRoute("/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  const auth = useAuth();
  const signOut = useSignOut();
  return (
    <div>
      Index {auth.userName}
      <button type="button" onClick={signOut}>
        Sign Out
      </button>
    </div>
  );
}
