import { generateId } from "@sqlite-sync/core";
import { useCallback } from "react";
import { useNoteDialogStore } from "@/lib/note-dialog-store";
import { useDb } from "@/user-db/user-db";

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
          order: maxOrder + 500,
          createdAt,
          tombstone: false,
        }),
      );
    });

    openNoteDialog(id);
  }, [db, openNoteDialog]);
}
