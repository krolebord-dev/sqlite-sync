import { useState, useRef, useCallback } from "react";
import { useDb } from "./db";

export function QueryShell() {
  const db = useDb();
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const prettyPrintRows = useCallback((rows: unknown[]) => {
    if (rows.length === 0) {
      console.log("✓ Query executed successfully. No rows returned.");
      return;
    }

    // Use console.table for nice table formatting
    console.table(rows);

    // Also log a summary
    console.log(
      `\n✓ Query executed successfully. ${rows.length} row${
        rows.length === 1 ? "" : "s"
      } returned.`
    );
  }, []);

  const executeQuery = useCallback(() => {
    if (!query.trim()) return;

    try {
      const result = db.memoryDb.execute(query);
      prettyPrintRows(result.rows);

      // Add to history
      setHistory((prev) => {
        // Don't add duplicate consecutive queries
        if (prev.length > 0 && prev[prev.length - 1] === query) {
          return prev;
        }
        return [...prev, query];
      });
      setHistoryIndex(-1);
      setQuery("");
    } catch (error) {
      console.error("Query error:", error);
    }
  }, [query, db, prettyPrintRows]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      const cursorPosition = textarea.selectionStart;
      const value = textarea.value;
      const lines = value.split("\n");
      const currentLineIndex =
        value.substring(0, cursorPosition).split("\n").length - 1;
      const isAtTopLine = currentLineIndex === 0;
      const isAtBottomLine = currentLineIndex === lines.length - 1;

      // Shift+Enter: Execute query
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        executeQuery();
        return;
      }

      // Up arrow: Navigate history backward
      if (e.key === "ArrowUp" && isAtTopLine && history.length > 0) {
        e.preventDefault();
        const newIndex =
          historyIndex === -1
            ? history.length - 1
            : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setQuery(history[newIndex]);
        return;
      }

      // Down arrow: Navigate history forward
      if (e.key === "ArrowDown" && isAtBottomLine && history.length > 0) {
        e.preventDefault();
        if (historyIndex !== -1) {
          const newIndex = historyIndex + 1;
          if (newIndex < history.length) {
            setHistoryIndex(newIndex);
            setQuery(history[newIndex]);
          } else {
            setHistoryIndex(-1);
            setQuery("");
          }
        }
        return;
      }

      // Reset history index when user types
      if (historyIndex !== -1 && !["ArrowUp", "ArrowDown"].includes(e.key)) {
        setHistoryIndex(-1);
      }
    },
    [executeQuery, history, historyIndex]
  );

  return (
    <div className="query-shell">
      <textarea
        ref={textareaRef}
        className="border border-gray-300 w-full p-2 font-mono text-sm"
        rows={10}
        placeholder="Enter SQL query (Enter to execute, Shift+Enter to add a new line, ↑/↓ for history)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
