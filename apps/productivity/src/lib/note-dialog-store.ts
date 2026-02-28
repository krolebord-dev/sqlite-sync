import { create } from "zustand";

interface NoteDialogStore {
  noteId: string | null;
  open: (id: string) => void;
  close: () => void;
}

export const useNoteDialogStore = create<NoteDialogStore>((set) => ({
  noteId: null,
  open: (id) => set({ noteId: id }),
  close: () => set({ noteId: null }),
}));
