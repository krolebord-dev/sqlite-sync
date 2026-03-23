import { generateId } from "@sqlite-sync/core";
import { useCallback, useState } from "react";
import { create } from "zustand";
import { combine } from "zustand/middleware";
import { useDebounceCallback } from "@/lib/use-debounced-callback";
import { useDb, useDbQuery } from "@/user-db/user-db";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

export const useNoteDialogStore = create(
  combine(
    {
      isOpen: false,
      noteId: null as string | null,
      openRevision: 0,
    },
    (set, get) => ({
      open: (id: string) => set({ isOpen: true, noteId: id, openRevision: get().openRevision + 1 }),
      close: () => set({ isOpen: false }),
    }),
  ),
);

export function useCreateNote() {
  const db = useDb();
  const openNoteDialog = useNoteDialogStore((s) => s.open);

  return useCallback(() => {
    const id = generateId();
    const createdAt = Date.now();

    db.db.executeTransaction((trx) => {
      const [maxOrderRow] = trx.executeKysely((q) =>
        q
          .selectFrom("item")
          .select((eb) => eb.fn.max("order").as("maxOrder"))
          .where("type", "=", "note"),
      ).rows;

      const maxOrder = Number(maxOrderRow?.maxOrder ?? 0);

      trx.executeKysely((q) =>
        q.insertInto("item").values({
          id,
          type: "note",
          title: "",
          content: "",
          order: maxOrder + 1,
          createdAt,
          tombstone: false,
        }),
      );
    });

    openNoteDialog(id);
  }, [db, openNoteDialog]);
}

function NoteDialogContent() {
  const closeDialog = useNoteDialogStore((x) => x.close);
  const isOpen = useNoteDialogStore((x) => x.isOpen);
  const noteId = useNoteDialogStore((x) => x.noteId);
  const db = useDb();

  const {
    data: [note],
  } = useDbQuery((q) => q.selectFrom("item").selectAll().where("id", "=", noteId));

  const [title, setTitle] = useState(note?.title ?? "");
  const [content, setContent] = useState(note?.content ?? "");

  const saveNote = useDebounceCallback((fields: { title?: string; content?: string }) => {
    db.db.executeKysely((q) => q.updateTable("item").set(fields).where("id", "=", noteId));
  }, 1000);

  const updateNote = (fields: { title?: string; content?: string }) => {
    setTitle(fields.title ?? title);
    setContent(fields.content ?? content);
    saveNote({
      title: fields.title ?? title,
      content: fields.content ?? content,
    });
  };

  function handleOpenChange(open: boolean) {
    if (!open) {
      saveNote.flush();
      closeDialog();
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Edit note</DialogTitle>
        <div className="flex flex-col gap-3">
          <Input
            placeholder="Title"
            value={title}
            onChange={(e) => {
              updateNote({ title: e.target.value });
            }}
            className="rounded-none border-0 border-b bg-transparent! px-0 font-semibold text-base shadow-none focus-visible:border-primary focus-visible:ring-0"
          />
          <Textarea
            placeholder="Take a note..."
            value={content}
            onChange={(e) => {
              updateNote({ content: e.target.value });
            }}
            className="min-h-40 resize-none rounded-none border-0 bg-transparent! px-0 shadow-none focus-visible:ring-0"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function NoteDialog() {
  const openRevision = useNoteDialogStore((x) => x.openRevision);
  return <NoteDialogContent key={openRevision} />;
}
