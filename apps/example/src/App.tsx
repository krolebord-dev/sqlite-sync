import { generateId } from "@sqlite-sync/core";
import { SQLiteSyncDevtools } from "@sqlite-sync/devtools";
import { useEffect, useRef, useState } from "react";
import { useDb, useDbQuery, useDbState } from "./db";
import { QueryShell } from "./QueryShell";

export function App() {
  const { db } = useDb();

  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [randomCount, setRandomCount] = useState(10);
  const [debugOpen, setDebugOpen] = useState(false);

  const { data: todos } = useDbQuery((db) => {
    let query = db.selectFrom("todo").selectAll().orderBy("id");

    if (newTodoTitle) {
      query = query.where("title", "like", `${newTodoTitle}%`);
    }

    return query.limit(100).orderBy("id", "asc");
  });

  const { data: todoStats } = useDbQuery(
    (db) => {
      const query = db
        .selectFrom("todo")
        .select(({ fn }) => [fn.countAll<number>().as("total"), fn.sum<number>("completed").as("completed")]);
      return query;
    },
    {
      mapData: ([todoStats]) => ({
        completedCount: Number(todoStats?.completed ?? 0),
        totalCount: Number(todoStats?.total ?? 0),
      }),
    },
  );

  const addTodo = () => {
    if (!newTodoTitle.trim()) return;

    db.executeKysely((db) =>
      db.insertInto("todo").values({
        id: generateId(),
        title: newTodoTitle.trim(),
        completed: false,
      }),
    );
    setNewTodoTitle("");
  };

  const addRandomTodos = () => {
    const count = Number(randomCount);
    if (Number.isNaN(count) || count <= 0) return;

    db.executeTransaction((trx) => {
      for (let i = 0; i < count; i += 100) {
        const batchSize = Math.min(100, count - i);
        const values = Array.from({ length: batchSize }).map(() => ({
          id: generateId(),
          title: `Random Todo ${Math.floor(Math.random() * 10000)}`,
          completed: false,
        }));
        trx.executeKysely((db) => db.insertInto("todo").values(values));
      }
    });
  };

  const toggleTodo = (id: string, currentCompleted: boolean) => {
    db.executeKysely((db) => db.updateTable("todo").set({ completed: !currentCompleted }).where("id", "=", id));
  };

  const deleteTodo = (id: string) => {
    db.executeKysely((db) => db.deleteFrom("todo").where("id", "=", id));
  };

  const updateTodoTitle = (id: string, newTitle: string) => {
    if (!newTitle.trim()) return;

    db.executeKysely((db) => db.updateTable("todo").set({ title: newTitle.trim() }).where("id", "=", id));
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)" }}>
      {/* ── Header ── */}
      <header
        style={{
          borderBottom: "1px solid var(--border)",
          padding: "14px 24px",
          position: "sticky",
          top: 0,
          background: "var(--bg)",
          zIndex: 10,
        }}
      >
        <div
          style={{
            maxWidth: "640px",
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          {/* Logo + wordmark */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <div
              style={{
                width: "30px",
                height: "30px",
                borderRadius: "7px",
                background: "var(--accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--bg)",
                fontFamily: "var(--font-display)",
                fontWeight: "400",
                fontSize: "16px",
                flexShrink: 0,
              }}
            >
              S
            </div>
            <div>
              <h1
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "18px",
                  fontWeight: "400",
                  lineHeight: "1.1",
                  letterSpacing: "-0.01em",
                  color: "var(--text)",
                }}
              >
                SQLite Sync
              </h1>
              <p
                style={{ fontSize: "10px", color: "var(--muted-fg)", fontFamily: "var(--font-mono)", marginTop: "1px" }}
              >
                local-first demo
              </p>
            </div>
          </div>

          {/* Right: sync status + debug toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <SyncStatusDot />
            <button
              type="button"
              className="debug-toggle"
              onClick={() => setDebugOpen((o) => !o)}
              title="Toggle developer tools"
              style={{
                background: debugOpen ? "var(--accent-dim)" : "transparent",
                border: `1px solid ${debugOpen ? "var(--accent-fg)" : "var(--border)"}`,
                borderRadius: "6px",
                padding: "5px 10px",
                color: debugOpen ? "var(--accent-fg)" : "var(--muted-fg)",
                fontSize: "11px",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                transition: "all 0.15s ease",
                letterSpacing: "0.02em",
              }}
            >
              {debugOpen ? "close dev" : "dev tools"}
            </button>
          </div>
        </div>
      </header>

      {/* ── Main content ── */}
      <main
        style={{
          maxWidth: "640px",
          margin: "0 auto",
          padding: "36px 24px",
          paddingBottom: debugOpen ? "62vh" : "80px",
        }}
      >
        {/* Add todo input */}
        <div
          style={{
            display: "flex",
            gap: "8px",
            marginBottom: "28px",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "10px",
            padding: "6px 6px 6px 16px",
            alignItems: "center",
            transition: "border-color 0.2s ease",
          }}
        >
          <input
            type="text"
            placeholder="Add a new task…"
            value={newTodoTitle}
            onChange={(e) => setNewTodoTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addTodo();
            }}
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              color: "var(--text)",
              fontSize: "15px",
              fontFamily: "var(--font-sans)",
            }}
          />
          <button
            type="button"
            className="btn-add"
            onClick={addTodo}
            style={{
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              borderRadius: "6px",
              width: "36px",
              height: "36px",
              fontSize: "22px",
              lineHeight: "1",
              cursor: "pointer",
              fontWeight: "400",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "opacity 0.15s ease",
            }}
          >
            +
          </button>
        </div>

        {/* Stats row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "20px",
          }}
        >
          <p style={{ fontSize: "12px", color: "var(--muted-fg)", fontFamily: "var(--font-mono)" }}>
            {todoStats.totalCount === 0 ? (
              "no tasks"
            ) : (
              <>
                <span style={{ color: "var(--text)" }}>{todoStats.totalCount}</span>
                {" tasks"}
                {todoStats.completedCount > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: "var(--success)" }}>{todoStats.completedCount}</span>
                    {" done"}
                  </>
                )}
              </>
            )}
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <button
              type="button"
              className="btn-random"
              onClick={addRandomTodos}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                padding: "4px 10px",
                color: "var(--muted-fg)",
                fontSize: "11px",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                transition: "all 0.15s ease",
                whiteSpace: "nowrap",
              }}
            >
              + {randomCount} random
            </button>
            <input
              type="number"
              min="1"
              value={randomCount}
              onChange={(e) => setRandomCount(parseInt(e.target.value, 10) || 0)}
              style={{
                width: "46px",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                padding: "4px 8px",
                color: "var(--muted-fg)",
                fontSize: "11px",
                fontFamily: "var(--font-mono)",
                outline: "none",
                textAlign: "center",
              }}
            />
          </div>
        </div>

        {/* Divider */}
        <div style={{ height: "1px", background: "var(--border)", marginBottom: "4px" }} />

        {/* Todo list */}
        <div>
          {todos.length === 0 ? (
            <div style={{ textAlign: "center", padding: "72px 24px" }}>
              <p
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: "22px",
                  color: "var(--muted-fg)",
                  fontStyle: "italic",
                  marginBottom: "8px",
                }}
              >
                Nothing here yet
              </p>
              <p style={{ fontSize: "12px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                add a task above to get started
              </p>
            </div>
          ) : (
            todos.map((todo) => (
              <TodoItem
                key={todo.id}
                todo={todo}
                onToggle={() => toggleTodo(todo.id, todo.completed)}
                onDelete={() => deleteTodo(todo.id)}
                onUpdateTitle={(newTitle) => updateTodoTitle(todo.id, newTitle)}
              />
            ))
          )}
        </div>
      </main>

      {/* ── Debug Panel ── */}
      {debugOpen && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "var(--surface)",
            borderTop: "1px solid var(--border)",
            maxHeight: "60vh",
            overflow: "auto",
            zIndex: 50,
          }}
        >
          <div
            style={{
              padding: "10px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: "14px",
              position: "sticky",
              top: 0,
              background: "var(--surface)",
            }}
          >
            <span
              style={{
                fontSize: "10px",
                color: "var(--muted-fg)",
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.1em",
              }}
            >
              DEV TOOLS
            </span>
            <BlockingIndicatorCompact />
            <button
              type="button"
              onClick={() => setDebugOpen(false)}
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "var(--muted-fg)",
                cursor: "pointer",
                fontSize: "14px",
                padding: "4px 6px",
                lineHeight: "1",
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ padding: "16px" }}>
            <QueryShell />
            <SQLiteSyncDevtools />
          </div>
        </div>
      )}
    </div>
  );
}

function TodoItem({
  todo,
  onToggle,
  onDelete,
  onUpdateTitle,
}: {
  todo: { id: string; title: string; completed: boolean };
  onToggle: () => void;
  onDelete: () => void;
  onUpdateTitle: (newTitle: string) => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(todo.title);
  const [hovered, setHovered] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [isEditing]);

  const handleSave = () => {
    if (editTitle.trim() && editTitle !== todo.title) {
      onUpdateTitle(editTitle);
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditTitle(todo.title);
    setIsEditing(false);
  };

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "10px 12px",
        borderRadius: "7px",
        background: hovered && !isEditing ? "var(--surface)" : "transparent",
        borderLeft: `2px solid ${hovered && !todo.completed && !isEditing ? "var(--accent)" : "transparent"}`,
        transition: "background 0.1s ease, border-color 0.1s ease",
      }}
    >
      <input type="checkbox" checked={todo.completed} onChange={onToggle} className="todo-checkbox" />

      {isEditing ? (
        <div style={{ flex: 1, display: "flex", gap: "6px" }}>
          <input
            ref={editRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              else if (e.key === "Escape") handleCancel();
            }}
            style={{
              flex: 1,
              background: "var(--surface-2)",
              border: "1px solid var(--accent)",
              borderRadius: "5px",
              padding: "5px 10px",
              color: "var(--text)",
              fontSize: "14px",
              fontFamily: "var(--font-sans)",
              outline: "none",
            }}
          />
          <button
            type="button"
            onClick={handleSave}
            style={{
              background: "var(--accent)",
              color: "var(--bg)",
              border: "none",
              borderRadius: "5px",
              padding: "5px 12px",
              fontSize: "12px",
              cursor: "pointer",
              fontWeight: "600",
              fontFamily: "var(--font-sans)",
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={handleCancel}
            style={{
              background: "transparent",
              color: "var(--muted-fg)",
              border: "1px solid var(--border)",
              borderRadius: "5px",
              padding: "5px 12px",
              fontSize: "12px",
              cursor: "pointer",
              fontFamily: "var(--font-sans)",
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <span
            onDoubleClick={() => setIsEditing(true)}
            style={{
              flex: 1,
              fontSize: "14px",
              lineHeight: "1.5",
              color: todo.completed ? "var(--muted-fg)" : "var(--text)",
              textDecoration: todo.completed ? "line-through" : "none",
              opacity: todo.completed ? 0.55 : 1,
              cursor: "default",
              transition: "color 0.15s ease, opacity 0.15s ease",
            }}
          >
            {todo.title}
          </span>

          <div
            style={{
              display: "flex",
              gap: "4px",
              opacity: hovered ? 1 : 0,
              transition: "opacity 0.15s ease",
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              className="btn-icon"
              onClick={() => setIsEditing(true)}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: "4px",
                padding: "3px 8px",
                color: "var(--muted-fg)",
                fontSize: "10px",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                transition: "all 0.1s ease",
                letterSpacing: "0.02em",
              }}
            >
              edit
            </button>
            <button
              type="button"
              className="btn-del"
              onClick={onDelete}
              style={{
                background: "transparent",
                border: "1px solid transparent",
                borderRadius: "4px",
                padding: "3px 8px",
                color: "var(--danger)",
                fontSize: "10px",
                cursor: "pointer",
                fontFamily: "var(--font-mono)",
                opacity: 0.65,
                transition: "all 0.1s ease",
                letterSpacing: "0.02em",
              }}
            >
              del
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SyncStatusDot() {
  const { state } = useDb();
  const dbState = useDbState();

  const toggleOnlineStatus = () => {
    if (dbState.remoteState === "online") {
      state.goOffline();
    } else {
      state.goOnline();
    }
  };

  const statusMap = {
    online: { color: "var(--success)", label: "synced", dotClass: "sync-dot-online" },
    pending: { color: "var(--warning)", label: "syncing…", dotClass: "sync-dot-pending" },
    offline: { color: "var(--danger)", label: "offline", dotClass: "" },
  } as const;

  const cfg = statusMap[dbState.remoteState as keyof typeof statusMap] ?? statusMap.offline;

  return (
    <button
      type="button"
      onClick={toggleOnlineStatus}
      disabled={dbState.remoteState === "pending"}
      title={`${dbState.remoteState} — click to toggle`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "6px",
        background: "transparent",
        border: "1px solid var(--border)",
        borderRadius: "20px",
        padding: "4px 10px 4px 8px",
        cursor: dbState.remoteState === "pending" ? "default" : "pointer",
        transition: "border-color 0.15s ease",
      }}
    >
      <span
        className={cfg.dotClass}
        style={{
          width: "7px",
          height: "7px",
          borderRadius: "50%",
          background: cfg.color,
          display: "block",
          flexShrink: 0,
        }}
      />
      <span
        style={{ fontSize: "10px", color: "var(--muted-fg)", fontFamily: "var(--font-mono)", letterSpacing: "0.02em" }}
      >
        {cfg.label}
      </span>
    </button>
  );
}

function BlockingIndicatorCompact() {
  const [rotation, setRotation] = useState(0);

  useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const deltaTime = currentTime - lastTime;
      lastTime = currentTime;
      setRotation((prev) => (prev + deltaTime * 0.36) % 360);
      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);
    return () => {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    };
  }, []);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "7px" }}>
      <div
        style={{
          width: "13px",
          height: "13px",
          borderRadius: "50%",
          border: "2px solid var(--accent)",
          borderTopColor: "transparent",
          transform: `rotate(${rotation}deg)`,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: "10px", color: "var(--muted-fg)", fontFamily: "var(--font-mono)" }}>
        ui thread monitor
      </span>
    </div>
  );
}
