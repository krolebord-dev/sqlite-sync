import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { TrendingUpIcon } from "lucide-react";
import { useAuth, useSignOut } from "@/lib/auth-client";
import { useActiveList } from "@/lib/use-list";
import { cn } from "@/lib/utils";
import { orpc } from "@/orpc/orpc-client";
import { Avatar, AvatarFallback } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type AppHeaderProps = {
  children: React.ReactNode;
  className?: string;
};
export function AppHeader({ children, className }: AppHeaderProps) {
  return (
    <header
      className={cn("flex h-14 items-center justify-between gap-2 border-border border-b bg-card px-4", className)}
    >
      {children}
    </header>
  );
}

type ProjectSelectorProps = {
  showCreate?: boolean;
};
export function ProjectSelector({ showCreate = true }: ProjectSelectorProps) {
  const lists = useSuspenseQuery(orpc.list.getLists.queryOptions());

  const selectedList = useActiveList();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={lists.isLoading || lists.isError || lists.data?.length === 0}
        className="flex h-10 w-56 items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-start text-sm ring-offset-background placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1"
      >
        {selectedList?.name || "Available lists..."}
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        {lists.data?.map((list) => (
          <DropdownMenuItem key={list.id} asChild>
            <Link to="/list/$id" params={{ id: list.id }}>
              {list.name}
            </Link>
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/trending">
            <TrendingUpIcon className="size-4" />
            Trending
          </Link>
        </DropdownMenuItem>
        {showCreate && (
          <DropdownMenuItem asChild>
            <Link to="/">Create new list</Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function UserAvatarDropdown() {
  const auth = useAuth();
  const logout = useSignOut();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Avatar className="cursor-pointer select-none">
          <AvatarFallback>{auth.userName.slice(0, 2)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuLabel>Profile</DropdownMenuLabel>
        <DropdownMenuLabel className="font-normal">{auth.userName}</DropdownMenuLabel>
        <DropdownMenuLabel className="font-normal">{auth.userEmail}</DropdownMenuLabel>

        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={logout} disabled={logout.isPending}>
          Logout
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
