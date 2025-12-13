// Re-export from db module for backwards compatibility
// The actual implementation now lives in @/db/use-list-items.ts
export {
  itemsFilterSchema,
  useSortedAndFilteredListItems as useSortedAndFilteredListItemsSelector,
  useListItems,
  getPriorityLabel,
  type UiListItem,
  type DbListItem,
  type SortingOptions,
} from '@/db/use-list-items';
