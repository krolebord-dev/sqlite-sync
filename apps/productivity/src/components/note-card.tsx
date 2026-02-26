import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { NoteItem } from "@/user-db/migrations";

type NoteCardProps = {
  note: NoteItem;
  onUpdate: (id: string, fields: Partial<Pick<NoteItem, "title" | "content">>) => void;
  onDelete: (id: string) => void;
};

export function NoteCard({ note, onUpdate, onDelete }: NoteCardProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [title, setTitle] = useState(note.title);
  const [content, setContent] = useState(note.content);

  useEffect(() => {
    if (!editOpen) {
      setTitle(note.title);
      setContent(note.content);
    }
  }, [note.title, note.content, editOpen]);

  useEffect(() => {
    if (!editOpen) return;
    if (title === note.title) return;
    const timer = setTimeout(() => onUpdate(note.id, { title }), 500);
    return () => clearTimeout(timer);
  }, [title, editOpen, note.id, note.title, onUpdate]);

  useEffect(() => {
    if (!editOpen) return;
    if (content === note.content) return;
    const timer = setTimeout(() => onUpdate(note.id, { content }), 500);
    return () => clearTimeout(timer);
  }, [content, editOpen, note.id, note.content, onUpdate]);

  function handleOpenChange(open: boolean) {
    if (!open) {
      if (title !== note.title) onUpdate(note.id, { title });
      if (content !== note.content) onUpdate(note.id, { content });
    }
    setEditOpen(open);
  }

  const { attributes, listeners, setNodeRef, transform, isDragging } = useSortable({
    id: note.id,
    animateLayoutChanges: () => false,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <>
      <div ref={setNodeRef} style={style} className="group mb-4 break-inside-avoid" {...attributes} {...listeners}>
        <div className="relative rounded-lg border bg-card text-card-foreground shadow-xs">
          {/* Hover actions */}
          <div className="absolute top-1.5 right-1.5 opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              className="rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label="Delete note"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(note.id);
              }}
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>

          <div
            className="cursor-pointer select-none px-4 py-3"
            onClick={() => {
              if (!isDragging) setEditOpen(true);
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

      <Dialog open={editOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogTitle className="sr-only">Edit note</DialogTitle>
          <div className="flex flex-col gap-3">
            <Input
              placeholder="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-none border-0 border-b bg-transparent! px-0 font-semibold text-base shadow-none focus-visible:border-primary focus-visible:ring-0"
            />
            <Textarea
              placeholder="Take a note..."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="min-h-40 resize-none rounded-none border-0 bg-transparent! px-0 shadow-none focus-visible:ring-0"
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
