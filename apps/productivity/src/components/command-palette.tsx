import { formatForDisplay } from "@tanstack/hotkeys";
import { useHotkey } from "@tanstack/react-hotkeys";
import { useNavigate } from "@tanstack/react-router";
import { Home, PlusIcon, StickyNote } from "lucide-react";
import { useSyncExternalStore } from "react";
import { useCommandStore } from "@/lib/command-store";
import { NEW_NOTE_HOTKEY } from "@/lib/hotkeys";
import { useCreateNote } from "@/lib/use-create-note";
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

  useHotkey("Mod+K", (e) => {
    e.preventDefault();
    toggle();
  });

  useHotkey(NEW_NOTE_HOTKEY, (e) => {
    e.preventDefault();
    createNote();
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
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
