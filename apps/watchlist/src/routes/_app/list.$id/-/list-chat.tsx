import { MessageCircle } from "lucide-react";
import { Component, lazy, type ReactNode, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { ChatSheetHeader } from "./chat-header";

// The chat pane pulls in the agent/AI-SDK runtime and suspends while connecting, so load it
// lazily and keep its loading/error states contained inside the sheet.
const ChatPane = lazy(() => import("./chat-pane"));

export function ListChat({ listId }: { listId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="icon"
          className="fixed right-4 bottom-4 z-50 size-12 rounded-full shadow-lg"
          aria-label="Open list assistant"
        >
          <MessageCircle className="size-5" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        showCloseButton={false}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-md"
      >
        {/* Remount the chat per list so messages and the agent connection don't leak across lists. */}
        {open ? (
          <ChatBoundary key={listId}>
            <Suspense
              fallback={
                <>
                  <ChatSheetHeader />
                  <ChatStatus>Connecting to the assistant…</ChatStatus>
                </>
              }
            >
              <ChatPane listId={listId} />
            </Suspense>
          </ChatBoundary>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ChatStatus({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
      <Spinner className="size-5" />
      {children}
    </div>
  );
}

// Keeps an agent connection/render failure inside the sheet instead of blanking the whole app.
class ChatBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm">
          <p>The assistant is unavailable right now.</p>
          <Button variant="outline" size="sm" onClick={() => this.setState({ failed: false })}>
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
