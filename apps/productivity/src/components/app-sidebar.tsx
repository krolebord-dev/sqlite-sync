import { Link, useMatches, useRouter } from "@tanstack/react-router";
import { ChevronsUpDown, Home, Loader2, LogOut, Menu, PlusIcon, Search, StickyNote, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth, useSignOut } from "@/lib/auth-client";
import { useCommandStore } from "@/lib/command-store";
import { cn } from "@/lib/utils";
import { useDb, useDbState } from "@/user-db/user-db";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Separator } from "./ui/separator";
import { Sheet, SheetContent, SheetTrigger } from "./ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const navItems = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/notes", label: "Notes", icon: StickyNote },
] as const;

const remoteStateConfig = {
  online: { label: "Online", icon: <Wifi className="size-4" />, className: "text-emerald-500" },
  pending: { label: "Connecting", icon: <Loader2 className="size-4 animate-spin" />, className: "text-amber-500" },
  offline: { label: "Offline", icon: <WifiOff className="size-4" />, className: "text-rose-500" },
} as const;

function RemoteStateIndicator() {
  const { state } = useDb();
  const { remoteState } = useDbState();
  const status = remoteStateConfig[remoteState ?? "offline"];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-8 w-8", status.className)}
          aria-label={`Sync status: ${status.label}`}
          onClick={() => (remoteState === "online" ? state.goOffline() : state.goOnline())}
        >
          {status.icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6}>
        {status.label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const auth = useAuth();
  const logout = useSignOut();
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.fullPath;
  const openCommand = useCommandStore((s) => s.open);

  return (
    <>
      <div className="flex h-14 items-center justify-between px-4">
        <span className="font-semibold text-base tracking-tight">Productivity</span>
        <RemoteStateIndicator />
      </div>

      <Separator />

      <div className="hidden p-2 md:block">
        <button
          type="button"
          onClick={openCommand}
          className="flex w-full items-center gap-2 rounded-md border bg-sidebar-accent/50 px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Search className="size-4" />
          <span className="flex-1 text-left">Search...</span>
          <kbd className="pointer-events-none rounded border bg-background px-1.5 font-mono text-[10px] text-muted-foreground">
            ⌘K
          </kbd>
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              currentPath === item.to
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        ))}
      </nav>

      <Separator />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md p-3 text-left transition-colors hover:bg-sidebar-accent"
          >
            <Avatar className="size-8">
              <AvatarFallback className="text-xs">{auth.userName.slice(0, 2)}</AvatarFallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium">{auth.userName}</span>
              <span className="truncate text-muted-foreground text-xs">{auth.userEmail}</span>
            </div>
            <ChevronsUpDown className="size-4 shrink-0 text-sidebar-foreground/50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-[--radix-dropdown-menu-trigger-width]">
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-2">
              <Avatar className="size-8">
                <AvatarFallback className="text-xs">{auth.userName.slice(0, 2)}</AvatarFallback>
              </Avatar>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{auth.userName}</span>
                <span className="truncate text-muted-foreground text-xs">{auth.userEmail}</span>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={logout} disabled={logout.isPending}>
            <LogOut className="size-4" />
            Logout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

function MobileSidebar() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  // Close sheet on route change (e.g. back/forward navigation)
  useEffect(() => {
    return router.subscribe("onBeforeNavigate", () => setOpen(false));
  }, [router]);

  const openCommand = useCommandStore((s) => s.open);

  return (
    <>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button
            variant="secondary"
            size="icon"
            className="fixed bottom-4 left-4 z-40 size-11 !rounded-full shadow-lg md:hidden"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent className="bg-sidebar text-sidebar-foreground">
          <SidebarContent onNavigate={() => setOpen(false)} />
        </SheetContent>
      </Sheet>

      <Button
        variant="default"
        size="icon"
        className="fixed right-4 bottom-4 z-40 size-11 !rounded-full shadow-lg md:hidden"
        aria-label="Open command palette"
        onClick={openCommand}
      >
        <PlusIcon className="size-5" />
      </Button>
    </>
  );
}

export function AppSidebar() {
  return (
    <>
      {/* Desktop sidebar */}
      <aside className="hidden h-full w-56 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground md:flex">
        <SidebarContent />
      </aside>

      {/* Mobile sheet trigger + sheet */}
      <MobileSidebar />
    </>
  );
}
