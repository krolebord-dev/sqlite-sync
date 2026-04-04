import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, type ErrorComponentProps, Link, Outlet } from "@tanstack/react-router";
import { AlertTriangle, FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient;
}>()({
  component: Root,
  notFoundComponent: NotFound,
  errorComponent: ErrorPage,
});

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <FileQuestion className="size-7" />
        </div>
        <div>
          <h1 className="font-bold text-5xl tabular-nums">404</h1>
          <p className="mt-1 text-muted-foreground">Page not found</p>
        </div>
        <Button asChild className="mt-2">
          <Link to="/">Go home</Link>
        </Button>
      </div>
    </div>
  );
}

function ErrorPage({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-xl bg-destructive/10 text-destructive">
          <AlertTriangle className="size-7" />
        </div>
        <div>
          <h1 className="font-bold text-2xl">Something went wrong</h1>
          <p className="mt-1 max-w-sm text-muted-foreground text-sm">{error.message}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button asChild variant="outline">
            <Link to="/">Go home</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

function Root() {
  return (
    <>
      <Outlet />
      <Toaster closeButton />
    </>
  );
}
