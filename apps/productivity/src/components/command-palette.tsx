import { formatForDisplay } from "@tanstack/hotkeys";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";
import { Home, PlusIcon, StickyNote, Wallet } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useCreateAccount } from "@/components/account-dialog";
import { useCreateNote } from "@/components/note-dialog";
import { useCommandStore } from "@/lib/command-store";
import { NEW_ACCOUNT_HOTKEY, NEW_NOTE_HOTKEY } from "@/lib/hotkeys";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "./ui/command";

const mdQuery = "(min-width: 768px)";
const subscribe = (cb: () => void) => {
  const mql = window.matchMedia(mdQuery);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
};
const getSnapshot = () => window.matchMedia(mdQuery).matches;
const getServerSnapshot = () => true;
function useIsDesktop() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function CommandPalette() {
  const { isOpen, close, toggle } = useCommandStore();
  const navigate = useNavigate();
  const isDesktop = useIsDesktop();
  const createNote = useCreateNote();
  const createAccount = useCreateAccount();

  useHotkey("Mod+K", (e) => {
    e.preventDefault();
    toggle();
  });

  useHotkey(NEW_NOTE_HOTKEY, (e) => {
    e.preventDefault();
    createNote();
  });

  useHotkey(NEW_ACCOUNT_HOTKEY, (e) => {
    e.preventDefault();
    createAccount();
  });

  function runAndClose(fn: () => void) {
    fn();
    close();
  }

  return (
    <CommandDialog open={isOpen} onOpenChange={(open) => !open && close()}>
      <CommandInput placeholder="Type a command or search..." autoFocus={isDesktop} />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem onSelect={() => runAndClose(createNote)}>
            <PlusIcon className="size-4" />
            New note
            <CommandShortcut>{formatForDisplay(NEW_NOTE_HOTKEY)}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(createAccount)}>
            <PlusIcon className="size-4" />
            New account
            <CommandShortcut>{formatForDisplay(NEW_ACCOUNT_HOTKEY)}</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Navigation">
          <CommandItem onSelect={() => runAndClose(() => navigate({ to: "/" }))}>
            <Home className="size-4" />
            Dashboard
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => navigate({ to: "/notes" }))}>
            <StickyNote className="size-4" />
            Notes
          </CommandItem>
          <CommandItem onSelect={() => runAndClose(() => navigate({ to: "/accounts" }))}>
            <Wallet className="size-4" />
            Accounts
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
