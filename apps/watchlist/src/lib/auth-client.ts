import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLoaderData, useNavigate } from "@tanstack/react-router";
import { orpc } from "@/orpc/orpc-client";

export function useSignOut() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signOutMutation = useMutation(
    orpc.auth.signOut.mutationOptions({
      onSuccess: async () => {
        navigate({ to: "/sign-in", replace: true, reloadDocument: true });
        queryClient.invalidateQueries();
      },
    }),
  );

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
