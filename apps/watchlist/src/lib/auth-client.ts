import { useMutation } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { signOut as signOutFn } from "./auth";

export function useSignOut() {
  const navigate = useNavigate();
  const signOutMutation = useMutation({
    mutationFn: signOutFn,
    onSuccess: async () => {
      navigate({ to: "/sign-in", replace: true, reloadDocument: true });
    },
  });

  return () => {
    signOutMutation.mutate({});
  };
}

export function useAuth() {
  const routeContext = useRouteContext({ from: "/_app" });

  return routeContext.auth;
}
