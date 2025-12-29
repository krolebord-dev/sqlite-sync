import { generateId } from "@sqlite-sync/core";
import { useEffect, useState } from "react";
import { useDb, useDbQuery, useDbState } from "./db";
import { QueryShell } from "./QueryShell";

export function App() {
  const { db } = useDb();

  const [newTodoTitle, setNewTodoTitle] = useState("");
  const [randomCount, setRandomCount] = useState(10);

  const { rows: todos } = useDbQuery({
    parameters: [newTodoTitle],
    queryFn: (db, [newTodoTitle]) => {
      let query = db.selectFrom("todo").selectAll().orderBy("id");

      if (newTodoTitle) {
        query = query.where("title", "like", `${newTodoTitle}%`);
      }

      return query.limit(100).orderBy("id", "asc");
    },
  });

  const {
    rows: [todoStats],
  } = useDbQuery({
    queryFn: (db) => {
      const query = db
        .selectFrom("todo")
        .select(({ fn }) => [fn.countAll<number>().as("total"), fn.sum<number>("completed").as("completed")]);
      return query;
    },
  });
  const completedCount = Number(todoStats?.completed ?? 0);
  const totalCount = todoStats?.total ?? 0;

  // Create a new todo
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
    <div className="mx-auto max-w-2xl p-8">
      <a href="/">
        <h1 className="mb-4 font-bold text-3xl">SQLite Sync Todo Demo</h1>
      </a>
      <p className="mb-6 text-gray-600">A todo list powered by SQLite Sync with live queries and optimistic updates.</p>
      <OnlineStatusButton />
      <BlockingIndicator />

      <QueryShell />

      <div className="mt-6 rounded bg-gray-100 p-4">
        <p className="text-sm">
          ✅ Optimistic DB (in-memory) ready
          <br />✅ Sync DB (persistent) ready
          <br />✅ {totalCount} active todos ({completedCount} completed)
        </p>
      </div>

      {/* Add new todo */}
      <div className="mt-6 flex gap-2">
        <input
          className="flex-1 rounded border border-gray-300 px-3 py-2"
          type="text"
          placeholder="Add a new todo..."
          value={newTodoTitle}
          onChange={(e) => setNewTodoTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              addTodo();
            }
          }}
        />
        <button type="button" className="rounded bg-blue-500 px-4 py-2 text-white hover:bg-blue-600" onClick={addTodo}>
          Add
        </button>
      </div>

      {/* Add random todos */}
      <div className="mt-4 flex gap-2">
        <input
          className="w-auto rounded border border-gray-300 px-3 py-2"
          type="number"
          min="1"
          value={randomCount}
          onChange={(e) => setRandomCount(parseInt(e.target.value, 10) || 0)}
        />
        <button
          type="button"
          className="rounded bg-green-500 px-4 py-2 text-white hover:bg-green-600"
          onClick={addRandomTodos}
        >
          Add {randomCount} random todos
        </button>
      </div>

      {/* Todo list */}
      <div className="mt-6 space-y-2">
        {todos.length === 0 ? (
          <p className="py-8 text-center text-gray-500">No todos yet. Add one above!</p>
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
      className={`flex items-center gap-3 rounded border p-3 ${todo.completed ? "bg-gray-50 opacity-75" : "bg-white"}`}
    >
      <input type="checkbox" checked={todo.completed} onChange={onToggle} className="h-5 w-5 cursor-pointer" />
      {isEditing ? (
        <div className="flex flex-1 gap-2">
          <input
            className="flex-1 rounded border border-gray-300 px-2 py-1"
            type="text"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleSave();
              } else if (e.key === "Escape") {
                handleCancel();
              }
            }}
          />
          <button
            type="button"
            className="rounded bg-green-500 px-2 py-1 text-sm text-white hover:bg-green-600"
            onClick={handleSave}
          >
            Save
          </button>
          <button
            type="button"
            className="rounded bg-gray-300 px-2 py-1 text-sm hover:bg-gray-400"
            onClick={handleCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <span
            className={`flex-1 cursor-pointer ${todo.completed ? "text-gray-500 line-through" : ""}`}
            onDoubleClick={() => setIsEditing(true)}
          >
            {todo.title}
          </span>
          <button
            type="button"
            className="px-2 py-1 text-gray-600 text-sm hover:text-gray-800"
            onClick={() => setIsEditing(true)}
          >
            Edit
          </button>
          <button
            type="button"
            className="rounded bg-red-500 px-2 py-1 text-sm text-white hover:bg-red-600"
            onClick={onDelete}
          >
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function OnlineStatusButton() {
  const { workerDb } = useDb();
  const dbState = useDbState();

  const toggleOnlineStatus = () => {
    if (dbState.remoteState === "online") {
      workerDb.goOffline();
    } else {
      workerDb.goOnline();
    }
  };

  return (
    <button
      type="button"
      className={`rounded px-4 py-2 text-white ${
        dbState.remoteState === "online"
          ? "bg-blue-500 hover:bg-blue-600"
          : dbState.remoteState === "pending"
            ? "bg-yellow-500 hover:bg-yellow-600"
            : "bg-red-500 hover:bg-red-600"
      }`}
      disabled={dbState.remoteState === "pending"}
      onClick={toggleOnlineStatus}
    >
      {dbState.remoteState}
    </button>
  );
}

function BlockingIndicator() {
  const [rotation, setRotation] = useState(0);
  const [frameCount, setFrameCount] = useState(0);

  useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const deltaTime = currentTime - lastTime;
      lastTime = currentTime;

      // Update rotation (360 degrees per second)
      setRotation((prev) => (prev + deltaTime * 0.36) % 360);

      // Update frame counter
      setFrameCount((prev) => prev + 1);

      animationFrameId = requestAnimationFrame(animate);
    };

    animationFrameId = requestAnimationFrame(animate);

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, []);

  return (
    <div className="mb-6 rounded border border-yellow-200 bg-yellow-50 p-4">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div
            className="h-8 w-8 rounded-full border-4 border-blue-500 border-t-transparent"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: "none",
            }}
          />
          <span className="font-medium text-gray-700 text-sm">UI Thread Monitor</span>
        </div>
        <div className="text-gray-600 text-xs">
          Frame: {frameCount} | Rotation: {Math.round(rotation)}°
        </div>
        <div className="ml-auto text-gray-500 text-xs italic">
          If this stutters, operations are blocking the UI thread
        </div>
      </div>
    </div>
  );
}
