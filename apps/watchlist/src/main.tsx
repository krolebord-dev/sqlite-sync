import "./styles.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { setupOrpcQueryClientIntegration } from "./orpc/orpc-client";
import { routeTree } from "./routeTree.gen";

const queryClient = new QueryClient();

const router = createRouter({
  routeTree,
  context: {
    queryClient,
  },
  scrollRestoration: true,
  defaultPreloadStaleTime: 0,
});

setupOrpcQueryClientIntegration(queryClient, router);

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

const rootElement = document.getElementById("root");
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={700}>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
