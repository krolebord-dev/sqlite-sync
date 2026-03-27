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
import { arraySwap, rectSwappingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { formatForDisplay } from "@tanstack/hotkeys";
import { createFileRoute } from "@tanstack/react-router";
import { PlusIcon, StickyNote } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { MasonryGrid } from "@/components/masonry-grid";
import { NoteCard } from "@/components/note-card";
import { useCreateNote } from "@/components/note-dialog";
import { Button } from "@/components/ui/button";
import { NEW_NOTE_HOTKEY } from "@/lib/hotkeys";
import { useDb, useDbQuery } from "@/user-db/user-db";

export const Route = createFileRoute("/_app/notes")({
  component: NotesPage,
});

function NotesPage() {
  const db = useDb();
  const createNote = useCreateNote();

  const { data: list } = useDbQuery(
    (db) => db.selectFrom("item").selectAll().where("type", "=", "note").orderBy("order", "asc"),
    {
      mapData: (notes) => ({
        notes: notes,
        timestamp: Date.now(),
      }),
    },
  );
  const [optimisticList, _setOptimisticList] = useState<typeof list>(list);

  const setOptimisticList = useCallback((notes: (typeof list)["notes"]) => {
    _setOptimisticList({
      notes,
      timestamp: Date.now(),
    });
  }, []);

  const notes = list.timestamp > optimisticList.timestamp ? list.notes : optimisticList.notes;

  const noteIds = useMemo(() => notes.map((note) => note.id), [notes]);

  const [activeId, setActiveId] = useState<string | null>(null);
  const activeNote = useMemo(() => notes.find((note) => note.id === activeId), [notes, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as string);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldOrder = over.data.current?.order;
    const newOrder = active.data.current?.order;

    if (oldOrder === undefined || newOrder === undefined) return;

    const oldIndex = notes.findIndex((note) => note.id === active.id);
    const newIndex = notes.findIndex((note) => note.id === over.id);
    setOptimisticList(arraySwap(notes, oldIndex, newIndex));

    db.db.executeTransaction((trx) => {
      trx.executeKysely((q) =>
        q
          .updateTable("item")
          .set({ order: oldOrder })
          .where("id", "=", active.id as string),
      );
      trx.executeKysely((q) =>
        q
          .updateTable("item")
          .set({ order: newOrder })
          .where("id", "=", over.id as string),
      );
    });
  }

  return (
    <div className="px-4 py-4 sm:px-6 sm:py-6">
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="font-semibold text-xl">Notes</h1>
        <Button onClick={createNote} size="sm">
          <PlusIcon />
          New note
          <kbd className="pointer-events-none hidden rounded border bg-background px-1.5 font-mono text-[10px] text-muted-foreground md:inline">
            {formatForDisplay(NEW_NOTE_HOTKEY)}
          </kbd>
        </Button>
      </div>

      {notes.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-card px-6 py-14 text-center">
          <StickyNote className="size-8 text-muted-foreground" />
          <div>
            <p className="font-medium">No notes yet</p>
            <p className="text-muted-foreground text-sm">Create one to start capturing your thoughts.</p>
          </div>
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
        <SortableContext items={noteIds} strategy={rectSwappingStrategy}>
          <MasonryGrid
            items={notes}
            itemKey={(note) => note.id}
            columnWidth={280}
            gap={16}
            renderItem={(note) => <NoteCard key={note.id} note={note} />}
          />
        </SortableContext>

        <DragOverlay>
          {activeNote && (
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
          )}
        </DragOverlay>
      </DndContext>
    </div>
  );
}
