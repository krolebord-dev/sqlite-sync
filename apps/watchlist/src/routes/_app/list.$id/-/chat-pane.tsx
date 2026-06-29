import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { CircleStop, Send, Sparkles, Trash2 } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChatSheetHeader } from "./chat-header";

const TOOL_LABELS: Record<string, string> = {
  getDbSchema: "Reading your list's structure",
  queryDb: "Looking through your list",
  mutateDb: "Updating your list",
  searchTitles: "Searching TMDB",
  getTrending: "Checking what's trending",
  getWatchProviders: "Finding where to watch",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? `Running ${name}`;
}

export default function ChatPane({ listId }: { listId: string }) {
  const agent = useAgent({ agent: "chat-agent", name: `list-${listId}:main` });
  const { messages, sendMessage, status, stop, error, clearHistory, isServerStreaming } = useAgentChat({ agent });
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Covers the full turn: client request/response (submitted/streaming) plus the server-side
  // window (tool calls, thinking between steps) reported by isServerStreaming.
  const isWorking = status === "submitted" || status === "streaming" || isServerStreaming;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  function submit() {
    const text = input.trim();
    if (!text || isWorking) {
      return;
    }
    sendMessage({ text });
    setInput("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChatSheetHeader
        actions={
          messages.length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => clearHistory()}
                  disabled={isWorking}
                  aria-label="Clear chat"
                >
                  <Trash2 className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>Clear chat</TooltipContent>
            </Tooltip>
          ) : null
        }
      />
      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-4">
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
        {isWorking ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" /> Thinking…
          </div>
        ) : null}
        {error ? <p className="text-destructive text-sm">Something went wrong. Try again.</p> : null}
      </div>
      <div className="border-t p-3">
        <div className="flex items-end gap-2">
          <Textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask the assistant…"
            rows={1}
            className="max-h-32 min-h-9 resize-none"
          />
          {isWorking ? (
            <Button size="icon" variant="secondary" onClick={() => stop()} aria-label="Stop">
              <CircleStop className="size-4" />
            </Button>
          ) : (
            <Button size="icon" onClick={submit} disabled={!input.trim()} aria-label="Send">
              <Send className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground text-sm"
            : "w-full space-y-2 text-sm"
        }
      >
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            if (isUser) {
              return (
                <p key={`${message.id}-${index}`} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              );
            }
            return <Streamdown key={`${message.id}-${index}`}>{part.text}</Streamdown>;
          }
          // Tools defined server-side (createDbTools) arrive as `dynamic-tool` parts, not typed
          // `tool-<name>` parts — handle both so the badge always shows.
          if (part.type === "dynamic-tool" || isToolUIPart(part)) {
            const name = part.type === "dynamic-tool" ? part.toolName : getToolName(part);
            const done = part.state === "output-available" || part.state === "output-error";
            return (
              <div key={`${message.id}-${index}`} className="flex items-center gap-2 text-muted-foreground text-xs">
                {done ? <Sparkles className="size-3" /> : <Spinner className="size-3" />}
                {toolLabel(name)}
              </div>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
