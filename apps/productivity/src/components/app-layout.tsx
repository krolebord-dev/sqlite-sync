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
