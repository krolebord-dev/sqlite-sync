import { useState, useEffect } from "react";
import { useDb, useDbQuery } from "./db";
import { QueryShell } from "./QueryShell";
import { generateId } from "./lib/utils";

export function App() {
  const db = useDb();
  const [isTabSyncEnabled, setIsTabSyncEnabled] = useState(true);
  const toggleTabSync = () => {
    setIsTabSyncEnabled(!isTabSyncEnabled);
    db.tabSyncEnabled = !isTabSyncEnabled;
  };

  const [newTodoTitle, setNewTodoTitle] = useState("");

  // Query all active todos (not tombstoned)
  const { rows: todos } = useDbQuery({
    queryFn: (db) =>
      db
        .selectFrom("todo")
        .selectAll()
        .where("tombstone", "=", false)
        .orderBy("id"),
  });

  // Count active todos
  const {
    rows: [todoStats],
  } = useDbQuery({
    queryFn: (db) =>
      db
        .selectFrom("todo")
        .where("tombstone", "=", false)
        .select(({ fn }) => [
          fn.countAll<number>().as("total"),
          fn.sum<number>("completed").as("completed"),
        ]),
  });

  const completedCount = Number(todoStats?.completed ?? 0);
  const totalCount = todoStats?.total ?? 0;

  // Create a new todo
  const addTodo = () => {
    if (!newTodoTitle.trim()) return;

    db.memoryDb.db.executeKysely((db: any) =>
      db.insertInto("todo").values({
        id: generateId(),
        title: newTodoTitle.trim(),
        completed: false,
        tombstone: false,
      })
    );
    db.memoryDb.notifyTableSubscribers(["todo"]);
    setNewTodoTitle("");
  };

  // Toggle todo completion
  const toggleTodo = (id: string, currentCompleted: boolean) => {
    db.memoryDb.db.executeKysely((db: any) =>
      db
        .updateTable("todo")
        .set({ completed: !currentCompleted })
        .where("id", "=", id)
    );
    db.memoryDb.notifyTableSubscribers(["todo"]);
  };

  // Delete a todo (set tombstone to true)
  const deleteTodo = (id: string) => {
    db.memoryDb.db.executeKysely((db: any) =>
      db.updateTable("todo").set({ tombstone: true }).where("id", "=", id)
    );
    db.memoryDb.notifyTableSubscribers(["todo"]);
  };

  // Update todo title
  const updateTodoTitle = (id: string, newTitle: string) => {
    if (!newTitle.trim()) return;

    db.memoryDb.db.executeKysely((db: any) =>
      db
        .updateTable("todo")
        .set({ title: newTitle.trim() })
        .where("id", "=", id)
    );
    db.memoryDb.notifyTableSubscribers(["todo"]);
  };

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h1 className="text-3xl font-bold mb-4">SQLite Sync Todo Demo</h1>
      <p className="text-gray-600 mb-6">
        A todo list powered by SQLite Sync with live queries and optimistic
        updates.
      </p>
      <button
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        onClick={toggleTabSync}
      >
        {isTabSyncEnabled ? "Disable Tab Sync" : "Enable Tab Sync"}
      </button>

      <BlockingIndicator />

      <QueryShell />

      <div className="mt-6 p-4 bg-gray-100 rounded">
        <p className="text-sm">
          ✅ Optimistic DB (in-memory) ready
          <br />
          ✅ Sync DB (persistent) ready
          <br />✅ {totalCount} active todos ({completedCount} completed)
        </p>
      </div>

      {/* Add new todo */}
      <div className="mt-6 flex gap-2">
        <input
          className="flex-1 border border-gray-300 rounded px-3 py-2"
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
        <button
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
          onClick={addTodo}
        >
          Add
        </button>
      </div>

      {/* Todo list */}
      <div className="mt-6 space-y-2">
        {todos.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            No todos yet. Add one above!
          </p>
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
      className={`flex items-center gap-3 p-3 border rounded ${
        todo.completed ? "bg-gray-50 opacity-75" : "bg-white"
      }`}
    >
      <input
        type="checkbox"
        checked={todo.completed}
        onChange={onToggle}
        className="w-5 h-5 cursor-pointer"
      />
      {isEditing ? (
        <div className="flex-1 flex gap-2">
          <input
            className="flex-1 border border-gray-300 rounded px-2 py-1"
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
            autoFocus
          />
          <button
            className="px-2 py-1 text-sm bg-green-500 text-white rounded hover:bg-green-600"
            onClick={handleSave}
          >
            Save
          </button>
          <button
            className="px-2 py-1 text-sm bg-gray-300 rounded hover:bg-gray-400"
            onClick={handleCancel}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <span
            className={`flex-1 cursor-pointer ${
              todo.completed ? "line-through text-gray-500" : ""
            }`}
            onDoubleClick={() => setIsEditing(true)}
          >
            {todo.title}
          </span>
          <button
            className="px-2 py-1 text-sm text-gray-600 hover:text-gray-800"
            onClick={() => setIsEditing(true)}
          >
            Edit
          </button>
          <button
            className="px-2 py-1 text-sm bg-red-500 text-white rounded hover:bg-red-600"
            onClick={onDelete}
          >
            Delete
          </button>
        </>
      )}
    </div>
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
    <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full"
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: "none",
            }}
          />
          <span className="text-sm font-medium text-gray-700">
            UI Thread Monitor
          </span>
        </div>
        <div className="text-xs text-gray-600">
          Frame: {frameCount} | Rotation: {Math.round(rotation)}°
        </div>
        <div className="text-xs text-gray-500 italic ml-auto">
          If this stutters, operations are blocking the UI thread
        </div>
      </div>
    </div>
  );
}
