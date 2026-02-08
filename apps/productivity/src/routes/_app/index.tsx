import { createFileRoute } from "@tanstack/react-router";
import { AppHeader, UserAvatarDropdown } from "@/components/app-layout";

export const Route = createFileRoute("/_app/")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <>
      <AppHeader>
        <h1 className="font-bold text-xl">Productivity</h1>
        <UserAvatarDropdown />
      </AppHeader>
      <main className="mx-auto max-w-4xl px-4 py-8">
        <div className="flex flex-col items-center gap-6 pt-6 sm:pt-14">
          <h2 className="font-semibold text-2xl">Welcome back</h2>
          <p className="text-muted-foreground">Your personal productivity hub. Features coming soon.</p>
        </div>
      </main>
    </>
  );
}
