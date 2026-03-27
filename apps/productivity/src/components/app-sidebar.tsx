import type { DragEndEvent } from "@dnd-kit/core";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Link, useMatches, useNavigate, useRouter } from "@tanstack/react-router";
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronsUpDown,
  Home,
  Loader2,
  LogOut,
  Menu,
  PlusIcon,
  Search,
  StickyNote,
  Wallet,
  Wifi,
  WifiOff,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth, useSignOut } from "@/lib/auth-client";
import { useCommandStore } from "@/lib/command-store";
import { cn } from "@/lib/utils";
import { useDb, useDbQuery, useDbState } from "@/user-db/user-db";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
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
        <Link to="/" viewTransition className="font-semibold text-base tracking-tight">
          Productivity
        </Link>
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
            viewTransition
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-2 font-medium text-sm transition-colors",
              currentPath === item.to
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
            )}
          >
            <item.icon className="size-4" />
            {item.label}
          </Link>
        ))}
        <AccountsNavItem currentPath={currentPath} onNavigate={onNavigate} />
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
              <span className="truncate font-medium text-sm">{auth.userName}</span>
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
                <span className="truncate font-medium text-sm">{auth.userName}</span>
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

function formatCompactBalance(balance: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(balance);
  } catch {
    return `${currency} ${balance.toFixed(0)}`;
  }
}

type AccountRow = {
  id: string;
  labelColor: string;
  labelText: string;
  balance: number;
  currency: string;
  order: number;
};

function SortableAccountRow({
  account,
  isActive,
  onNavigate,
}: {
  account: AccountRow;
  isActive: boolean;
  onNavigate?: () => void;
}) {
  const sortable = useSortable({ id: account.id, data: { order: account.order } });
  const navigate = useNavigate();

  return (
    <button
      type="button"
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
      {...sortable.attributes}
      {...sortable.listeners}
      onClick={() => {
        if (!sortable.isDragging) {
          navigate({ to: "/transactions", search: { accountId: account.id }, viewTransition: true });
          onNavigate?.();
        }
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
        isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70",
        sortable.isDragging && "opacity-50",
      )}
    >
      <span className="inline-block size-2.5 shrink-0 rounded-full" style={{ backgroundColor: account.labelColor }} />
      <span className="flex-1 truncate text-left">{account.labelText || "Untitled"}</span>
      <span className="font-mono text-muted-foreground text-xs tabular-nums">
        {formatCompactBalance(account.balance, account.currency)}
      </span>
    </button>
  );
}

function AccountsNavItem({ currentPath, onNavigate }: { currentPath: string | undefined; onNavigate?: () => void }) {
  const db = useDb();
  const { data: accounts } = useDbQuery((db) =>
    db
      .selectFrom("account")
      .select(["id", "labelColor", "labelText", "balance", "currency", "order"])
      .orderBy("order", "asc"),
  );

  const matches = useMatches();
  const lastMatch = matches[matches.length - 1];
  const activeAccountId =
    lastMatch?.fullPath === "/transactions" ? (lastMatch.search as { accountId?: string }).accountId : undefined;

  const isActive = currentPath === "/transactions";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldOrder = over.data.current?.order;
    const newOrder = active.data.current?.order;
    if (oldOrder === undefined || newOrder === undefined) return;

    db.db.executeTransaction((trx) => {
      trx.executeKysely((q) =>
        q
          .updateTable("account")
          .set({ order: oldOrder })
          .where("id", "=", active.id as string),
      );
      trx.executeKysely((q) =>
        q
          .updateTable("account")
          .set({ order: newOrder })
          .where("id", "=", over.id as string),
      );
    });
  }

  return (
    <Collapsible defaultOpen={accounts.length > 0}>
      <div
        className={cn(
          "flex items-center gap-2 rounded-md font-medium text-sm transition-colors",
          isActive
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground",
        )}
      >
        <Link
          to="/transactions"
          viewTransition
          onClick={onNavigate}
          className="flex flex-1 items-center gap-2 px-3 py-2"
        >
          <Wallet className="size-4 shrink-0" />
          Accounts
        </Link>
        {accounts.length > 0 && (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="mr-2 rounded-sm p-0.5 opacity-60 transition-opacity hover:opacity-100"
              aria-label="Toggle accounts list"
            >
              <ChevronDown className="size-3.5 transition-transform [[data-state=closed]_&]:-rotate-90" />
            </button>
          </CollapsibleTrigger>
        )}
      </div>
      <CollapsibleContent>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={accounts.map((a) => a.id)} strategy={verticalListSortingStrategy}>
            <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-sidebar-border/50 pl-3">
              {accounts.map((account) => (
                <SortableAccountRow
                  key={account.id}
                  account={account}
                  isActive={activeAccountId === account.id}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </CollapsibleContent>
    </Collapsible>
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
            className="!rounded-full fixed bottom-4 left-4 z-40 size-11 shadow-lg md:hidden"
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
        className="!rounded-full fixed right-4 bottom-4 z-40 size-11 shadow-lg md:hidden"
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
