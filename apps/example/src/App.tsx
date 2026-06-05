import { generateId } from "@sqlite-sync/core";
import { SQLiteSyncDevtools } from "@sqlite-sync/devtools";
import { useEffect, useRef, useState } from "react";
import { useDb, useDbQuery, useDbState } from "./db";
import { QueryShell } from "./QueryShell";

export function App() {
  const { db } = useDb();

  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [randomCount, setRandomCount] = useState(10);
  const [debugOpen, setDebugOpen] = useState(false);

  const { data: todos } = useDbQuery((db) => {
    let query = db.selectFrom("todo").selectAll().orderBy("id");

    if (searchQuery.trim()) {
      query = query.where("title", "like", `${searchQuery.trim()}%`);
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
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <h1>
            <a href="/">SQLite Sync demo</a>
          </h1>
          <div className="header-actions">
            <SyncStatus />
            <button type="button" className="btn btn-sm" onClick={() => setDebugOpen((o) => !o)}>
              {debugOpen ? "Hide devtools" : "Devtools"}
            </button>
          </div>
        </div>
      </header>

      <main className={debugOpen ? "main main--debug" : "main"}>
        <form
          className="add-form"
          onSubmit={(e) => {
            e.preventDefault();
            addTodo();
          }}
        >
          <input
            type="text"
            placeholder="New task"
            value={newTodoTitle}
            onChange={(e) => setNewTodoTitle(e.target.value)}
          />
          <button type="submit" className="btn btn-primary">
            Add
          </button>
        </form>

        <div className="stats">
          <span>
            {todoStats.totalCount === 0
              ? "No tasks"
              : `${todoStats.totalCount} task${todoStats.totalCount === 1 ? "" : "s"}${
                  todoStats.completedCount > 0 ? `, ${todoStats.completedCount} done` : ""
                }`}
          </span>
          <div className="stats-actions">
            <button type="button" className="btn btn-sm" onClick={addRandomTodos}>
              Add {randomCount} random
            </button>
            <input
              type="number"
              min="1"
              value={randomCount}
              onChange={(e) => setRandomCount(parseInt(e.target.value, 10) || 0)}
            />
          </div>
        </div>

        <label className="search-form">
          <span className="search-form-label">Filter</span>
          <input
            type="search"
            placeholder="Search by title"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>

        <div className="todo-list">
          {todos.length === 0 ? (
            <p className="todo-empty">{searchQuery.trim() ? "No tasks match your search." : "No tasks yet."}</p>
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

      {debugOpen && (
        <div className="debug-panel">
          <div className="debug-panel-header">
            <span>Developer tools</span>
            <button type="button" onClick={() => setDebugOpen(false)} aria-label="Close">
              ×
            </button>
          </div>
          <div className="debug-panel-body">
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
    <div className="todo-item">
      <input type="checkbox" checked={todo.completed} onChange={onToggle} />

      {isEditing ? (
        <div className="todo-edit">
          <input
            ref={editRef}
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave();
              else if (e.key === "Escape") handleCancel();
            }}
          />
          <button type="button" className="btn btn-sm btn-primary" onClick={handleSave}>
            Save
          </button>
          <button type="button" className="btn btn-sm" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <span
            className={todo.completed ? "todo-title todo-title--done" : "todo-title"}
            onDoubleClick={() => setIsEditing(true)}
          >
            {todo.title}
          </span>
          <div className="todo-actions">
            <button type="button" className="btn btn-sm" onClick={() => setIsEditing(true)}>
              Edit
            </button>
            <button type="button" className="btn btn-sm btn-danger" onClick={onDelete}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SyncStatus() {
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
    online: { color: "var(--success)", label: "Synced" },
    pending: { color: "var(--warning)", label: "Syncing" },
    offline: { color: "var(--danger)", label: "Offline" },
  } as const;

  const cfg = statusMap[dbState.remoteState as keyof typeof statusMap] ?? statusMap.offline;

  return (
    <button
      type="button"
      className="sync-btn"
      onClick={toggleOnlineStatus}
      disabled={dbState.remoteState === "pending"}
      title={`${dbState.remoteState} — click to toggle`}
    >
      <span className="sync-dot" style={{ background: cfg.color }} />
      {cfg.label}
    </button>
  );
}
