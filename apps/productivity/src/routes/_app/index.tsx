import { createFileRoute } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";

export const Route = createFileRoute("/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <div className="flex flex-col items-center gap-4 pt-6 sm:pt-14">
        <div className="flex items-center justify-center size-12 rounded-xl bg-primary/10 text-primary">
          <LayoutDashboard className="size-6" />
        </div>
        <h2 className="font-semibold text-2xl">Welcome back</h2>
        <p className="text-muted-foreground text-center">
          Your personal productivity hub. Use the sidebar to navigate.
        </p>
      </div>
    </div>
  );
}
