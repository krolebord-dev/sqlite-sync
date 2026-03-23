import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Trash2 } from "lucide-react";
import type { NoteItem } from "@/user-db/migrations";
import { useDb } from "@/user-db/user-db";
import { useNoteDialogStore } from "./note-dialog";

type NoteCardProps = {
  note: NoteItem;
};

export function NoteCard({ note }: NoteCardProps) {
  const sortable = useSortable({
    id: note.id,
    data: note,
    animateLayoutChanges: (args) => {
      return !args.wasDragging;
    },
  });

  const db = useDb();
  const openNoteDialog = useNoteDialogStore((s) => s.open);

  return (
    <div className="group">
      <div
        className="relative rounded-lg border bg-card text-card-foreground shadow-xs"
        ref={sortable.setNodeRef}
        style={{
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
        }}
        {...sortable.attributes}
        {...sortable.listeners}
      >
        {/* Hover actions */}
        <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
            aria-label="Delete note"
            onClick={(e) => {
              e.stopPropagation();
              db.db.executeKysely((q) => q.deleteFrom("item").where("id", "=", note.id));
            }}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>

        <div
          className="cursor-pointer select-none px-4 py-3"
          onClick={() => {
            if (!sortable.isDragging) openNoteDialog(note.id);
          }}
        >
          {note.title && <p className="mb-1 line-clamp-2 font-medium text-sm leading-snug">{note.title}</p>}
          {note.content ? (
            <p className="line-clamp-8 whitespace-pre-wrap text-muted-foreground text-sm leading-relaxed">
              {note.content}
            </p>
          ) : (
            !note.title && <p className="text-muted-foreground/50 text-sm italic">Empty note</p>
          )}
        </div>
      </div>
    </div>
  );
}
