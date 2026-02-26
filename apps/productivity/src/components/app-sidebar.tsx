import { Link, useMatches } from "@tanstack/react-router";
import { ChevronsUpDown, Home, LogOut, StickyNote } from "lucide-react";
import { useAuth, useSignOut } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Separator } from "./ui/separator";

const navItems = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/notes", label: "Notes", icon: StickyNote },
] as const;

export function AppSidebar() {
  const auth = useAuth();
  const logout = useSignOut();
  const matches = useMatches();
  const currentPath = matches[matches.length - 1]?.fullPath;

  return (
    <aside className="flex h-full w-56 shrink-0 flex-col border-sidebar-border border-r bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2 px-4">
        <span className="font-semibold text-base tracking-tight">Productivity</span>
      </div>

      <Separator />

      <nav className="flex flex-1 flex-col gap-1 p-2">
        {navItems.map((item) => (
          <Link
            key={item.to}
            to={item.to}
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
    </aside>
  );
}
