import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { TanStackRouterDevtools } from '@tanstack/router-devtools';
import type { trpcClient, trpcUtils } from '../trpc';

type RouterContext = {
  trpc: typeof trpcUtils;
  trpcClient: typeof trpcClient;
};

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
});

function Root() {
  return (
    <>
      <Outlet />
      {import.meta.env.DEV && <TanStackRouterDevtools />}
    </>
  );
}
