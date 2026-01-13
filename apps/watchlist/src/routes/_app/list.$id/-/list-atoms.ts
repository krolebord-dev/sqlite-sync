import type { SyncedDb } from "@sqlite-sync/core";
import { atom } from "jotai";
import { z } from "zod";
import type { ListDb } from "@/lib/list-db/migrations";

export const itemsFilterSchema = z.object({
  sortBy: z.enum(["duration", "rating", "createdAt", "priority"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  priority: z.enum(["high", "normal", "low", "any"]).default("any"),
});

export type SortingOptions = z.infer<typeof itemsFilterSchema>;

// biome-ignore lint/style/noNonNullAssertion: Set in provider
export const dbAtom = atom<SyncedDb<ListDb>>(null!);

export const selectedItemsAtom = atom<string[]>([]);
export const randomizedItemAtom = atom<string | null>(null);
export const editItemAtom = atom<string | null>(null);
export const searchQueryAtom = atom<string>("");

export const isSelectionModeAtom = atom((get) => get(selectedItemsAtom).length > 0);

export const selectAllAtom = atom(null, (get, set) => {
  const db = get(dbAtom);
  const allItemIds = db.db.executeKysely((db) => db.selectFrom("item").select("id")).rows.map((x) => x.id);
  set(selectedItemsAtom, allItemIds);
});

export const clearSelectedItemsAtom = atom(null, (_, set) => {
  set(selectedItemsAtom, []);
});

export const selectRandomFromSelectedItemsAtom = atom(null, (get, set) => {
  const selectedItems = get(selectedItemsAtom);
  const randomItemId = selectedItems[Math.floor(Math.random() * selectedItems.length)];
  set(randomizedItemAtom, randomItemId);
});
export const clearRandomizedItemAtom = atom(null, (_, set) => {
  set(randomizedItemAtom, null);
});

export const toggleItemSelectionAtom = atom(null, (get, set, itemId: string) => {
  const selectedItems = get(selectedItemsAtom);
  if (selectedItems.includes(itemId)) {
    set(
      selectedItemsAtom,
      selectedItems.filter((id) => id !== itemId),
    );
  } else {
    set(selectedItemsAtom, [...selectedItems, itemId]);
  }
});
