import './index.css';
import { QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { routeTree } from './routeTree.gen';
import { queryClient, trpc, trpcClient, trpcUtils } from './trpc';

const router = createRouter({
  routeTree,
  // biome-ignore lint/style/noNonNullAssertion: context is never null
  context: undefined!,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider
            router={router}
            context={{
              trpc: trpcUtils,
              trpcClient,
            }}
          />
        </QueryClientProvider>
      </trpc.Provider>
    </StrictMode>,
  );
}
