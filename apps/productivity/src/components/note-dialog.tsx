import { useCallback, useEffect, useRef, useState } from "react";
import { useNoteDialogStore } from "@/lib/note-dialog-store";
import type { NoteItem } from "@/user-db/migrations";
import { useDb, useDbQuery } from "@/user-db/user-db";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

function NoteDialogContent({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const db = useDb();

  const { data: notes } = useDbQuery((q) => q.selectFrom("item").selectAll().where("id", "=", noteId));
  const note = (notes as NoteItem[] | undefined)?.[0] ?? null;

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const hasHydratedRef = useRef(false);

  useEffect(() => {
    if (!note) return;
    if (hasHydratedRef.current) return;
    setTitle(note.title);
    setContent(note.content);
    hasHydratedRef.current = true;
  }, [note]);

  const updateNote = useCallback(
    (fields: { title?: string; content?: string }) => {
      db.db.executeKysely((q) => q.updateTable("item").set(fields).where("id", "=", noteId));
    },
    [db, noteId],
  );

  useEffect(() => {
    if (!note) return;
    if (title === note.title) return;
    const timer = setTimeout(() => updateNote({ title }), 500);
    return () => clearTimeout(timer);
  }, [title, note, updateNote]);

  useEffect(() => {
    if (!note) return;
    if (content === note.content) return;
    const timer = setTimeout(() => updateNote({ content }), 500);
    return () => clearTimeout(timer);
  }, [content, note, updateNote]);

  function handleOpenChange(open: boolean) {
    if (!open) {
      if (note) {
        if (title !== note.title) updateNote({ title });
        if (content !== note.content) updateNote({ content });
      }
      onClose();
    }
  }

  return (
    <Dialog open onOpenChange={handleOpenChange}>
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
  );
}

export function NoteDialog() {
  const { noteId, close } = useNoteDialogStore();

  if (!noteId) return null;

  return <NoteDialogContent key={noteId} noteId={noteId} onClose={close} />;
}
