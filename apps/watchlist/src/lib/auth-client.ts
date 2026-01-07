import { useMutation } from "@tanstack/react-query";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import { signOut as signOutFn } from "./auth";

export function useSignOut() {
  const navigate = useNavigate();
  const signOutMutation = useMutation({
    mutationFn: signOutFn,
    onSuccess: async () => {
      navigate({ to: "/sign-in", replace: true, reloadDocument: true });
    },
  });

  function signOut() {
    signOutMutation.mutate({});
  }

  signOut.isPending = signOutMutation.isPending;

  return signOut;
}

export function useAuth() {
  const routeContext = useLoaderData({ from: "/_app" });

  return routeContext.auth;
}
