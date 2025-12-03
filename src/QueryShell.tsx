import { useState, useRef, useCallback, useEffect } from "react";
import { useDb } from "./db";
import { startPerformanceLogger } from "./lib/logger";
import { logger } from "./logger";

type DbType = "memoryDb" | "workerDb";

const HISTORY_STORAGE_KEY = "queryShellHistory";
const MAX_HISTORY_SIZE = 100;

function loadHistoryFromStorage(): string[] {
  try {
    const stored = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (
        Array.isArray(parsed) &&
        parsed.every((item) => typeof item === "string")
      ) {
        return parsed;
      }
    }
  } catch (error) {
    console.warn("Failed to load history from localStorage:", error);
  }
  return [];
}

function saveHistoryToStorage(history: string[]): void {
  try {
    // Limit history size to avoid storing too much data
    const limitedHistory = history.slice(-MAX_HISTORY_SIZE);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(limitedHistory));
  } catch (error) {
    console.warn("Failed to save history to localStorage:", error);
  }
}

export function QueryShell() {
  const db = useDb();
  const [dbType, setDbType] = useState<DbType>("memoryDb");
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<string[]>(() =>
    loadHistoryFromStorage()
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Save history to localStorage whenever it changes
  useEffect(() => {
    saveHistoryToStorage(history);
  }, [history]);

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

  const toggleDb = useCallback(() => {
    setDbType((prev) => {
      const newType = prev === "memoryDb" ? "workerDb" : "memoryDb";
      console.log(
        `✓ Switched to ${
          newType === "memoryDb"
            ? "Memory DB (In-memory)"
            : "Worker DB (Persistent)"
        }`
      );
      return newType;
    });
  }, []);

  const crdtifyTable = (table: string) => {
    if (dbType !== "memoryDb") {
      console.error("Cannot crdtify table in worker DB");
      return;
    }

    const perf = startPerformanceLogger(logger);
    db.crdtifyTable(table);
    perf.logEnd("crdtifyTable", table, "info");
  };

  const addToHistory = useCallback((queryToAdd: string) => {
    setHistory((prev) => {
      // Don't add duplicate consecutive queries
      if (prev.length > 0 && prev[prev.length - 1] === queryToAdd) {
        return prev;
      }
      return [...prev, queryToAdd];
    });
    setHistoryIndex(-1);
  }, []);

  const executeQuery = async () => {
    if (!query.trim()) return;

    const trimmedQuery = query.trim();

    if (trimmedQuery === ".toggle") {
      toggleDb();
      addToHistory(trimmedQuery);
      setQuery("");
      return;
    } else if (trimmedQuery.startsWith(".crdt")) {
      const table = trimmedQuery.split(" ")[1];

      crdtifyTable(table);

      addToHistory(trimmedQuery);
      setQuery("");
      return;
    }

    try {
      let rows: unknown[] = [];

      if (dbType === "memoryDb") {
        const result = db.memoryDb.db.execute(query);
        rows = result.rows;
      } else {
        const result = await db.workerDb.execute({
          sql: query,
          parameters: [],
        });
        rows = result.rows;
      }

      prettyPrintRows(rows);

      // Add to history
      addToHistory(query);
      setQuery("");
    } catch (error) {
      console.error("Query error:", error);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
  };

  return (
    <div className="query-shell">
      <div className="flex items-center gap-2 mb-2">
        <label className="text-sm font-medium">Database:</label>
        <button
          type="button"
          onClick={toggleDb}
          className="px-3 py-1 border border-gray-300 rounded hover:bg-gray-100 text-sm"
        >
          {dbType === "memoryDb" ? "Memory DB" : "Worker DB"}
        </button>
        <span className="text-xs text-gray-500">
          ({dbType === "memoryDb" ? "In-memory" : "Persistent"})
        </span>
      </div>
      <textarea
        ref={textareaRef}
        className="border border-gray-300 w-full p-2 font-mono text-sm"
        rows={10}
        placeholder="Enter SQL query (Enter to execute, Shift+Enter to add a new line, ↑/↓ for history, .toggle to switch DB)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
