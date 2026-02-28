import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { formatForDisplay } from "@tanstack/hotkeys";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { NoteCard } from "@/components/note-card";
import { Button } from "@/components/ui/button";
import { NEW_NOTE_HOTKEY } from "@/lib/hotkeys";
import { useCreateNote } from "@/lib/use-create-note";
import type { NoteItem } from "@/user-db/migrations";
import { useDb, useDbQuery } from "@/user-db/user-db";

export const Route = createFileRoute("/_app/notes")({
  component: NotesPage,
});

function getOrderBetween(before: NoteItem | undefined, after: NoteItem | undefined): number {
  if (before && after) return (before.order + after.order) / 2;
  if (before) return before.order + 500;
  if (after) return after.order - 500;
  return 1000;
}

function NotesPage() {
  const db = useDb();
  const createNote = useCreateNote();
  const [activeId, setActiveId] = useState<string | null>(null);

  const { data: notes } = useDbQuery((db) =>
    db.selectFrom("item").selectAll().where("type", "=", "note").orderBy("order", "asc").orderBy("createdAt", "desc"),
  );

  const noteList = notes ?? [];
  const activeNote = activeId ? noteList.find((n) => n.id === activeId) : null;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const updateNote = useCallback(
    (id: string, fields: Partial<Pick<NoteItem, "title" | "content">>) => {
      db.db.executeKysely((q) => q.updateTable("item").set(fields).where("id", "=", id));
    },
    [db],
  );

  const deleteNote = useCallback(
    (id: string) => {
      db.db.executeKysely((q) => q.deleteFrom("item").where("id", "=", id));
      toast.success("Note deleted");
    },
    [db],
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = noteList.findIndex((n) => n.id === active.id);
    const newIndex = noteList.findIndex((n) => n.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = [...noteList];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    const before = reordered[newIndex - 1];
    const after = reordered[newIndex + 1];
    const newOrder = getOrderBetween(before, after);

    db.db.executeKysely((q) =>
      q
        .updateTable("item")
        .set({ order: newOrder })
        .where("id", "=", active.id as string),
    );
  }

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6">
      <div className="mb-4 sm:mb-6 flex items-center justify-between">
        <h1 className="font-semibold text-xl">Notes</h1>
        <Button onClick={createNote} size="sm">
          <PlusIcon />
          New note
          <kbd className="pointer-events-none hidden rounded border bg-background px-1.5 font-mono text-[10px] text-muted-foreground md:inline">
            {formatForDisplay(NEW_NOTE_HOTKEY)}
          </kbd>
        </Button>
      </div>

      {noteList.length === 0 && (
        <div className="flex flex-col items-center gap-3 pt-16 text-center">
          <p className="text-muted-foreground text-sm">No notes yet. Create one to get started.</p>
          <Button onClick={createNote} variant="outline">
            <PlusIcon />
            New note
          </Button>
        </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={noteList.map((n) => n.id)} strategy={rectSortingStrategy}>
          <div className="columns-1 gap-4 sm:columns-2 lg:columns-3 xl:columns-4">
            {noteList.map((note) => (
              <NoteCard key={note.id} note={note} onUpdate={updateNote} onDelete={deleteNote} />
            ))}
          </div>
        </SortableContext>

        <DragOverlay dropAnimation={null}>
          {activeNote ? (
            <div className="rotate-1 rounded-lg border bg-card opacity-90 shadow-xl">
              <div className="px-4 py-3">
                {activeNote.title && (
                  <p className="mb-1 line-clamp-2 font-medium text-sm leading-snug">{activeNote.title}</p>
                )}
                {activeNote.content && (
                  <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
                    {activeNote.content}
                  </p>
                )}
                {!activeNote.title && !activeNote.content && (
                  <p className="text-muted-foreground/50 text-sm italic">Empty note</p>
                )}
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
