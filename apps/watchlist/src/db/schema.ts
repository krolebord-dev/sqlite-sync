// Database schema types for the watchlist sqlite-sync database

// Base table (_list_items) - this is the CRDT-enabled table
export interface ListItemBase {
  id: string;
  type: 'movie' | 'tv';
  tmdb_id: number | null;
  title: string;
  poster_url: string | null;
  overview: string | null;
  duration: number | null;
  episode_count: number | null;
  rating: number | null;
  release_date: number | null;
  watched_at: number | null;
  priority: number;
  created_at: number;
  tombstone: boolean;
}

// CRDT view (list_items) - same structure, exposed as a view
export interface ListItem extends ListItemBase {}

// Tags table
export interface ListTag {
  id: string;
  name: string;
  tombstone: boolean;
}

// Tag to item association
export interface ListTagToItem {
  tag_id: string;
  item_id: string;
  tombstone: boolean;
}

// Full database schema for Kysely
export interface ListDatabase {
  // Base tables (prefixed with _)
  _list_items: ListItemBase;
  _list_tags: ListTag;
  _list_tags_to_items: ListTagToItem;
  
  // CRDT views (no prefix)
  list_items: ListItem;
  list_tags: ListTag;
  list_tags_to_items: ListTagToItem;
}

// Helper type for list item with tags (used in UI)
export interface ListItemWithTags extends Omit<ListItem, 'tombstone'> {
  tags: Array<{ id: string; name: string }>;
}

// Helper to convert database timestamps to Date objects
export function toDate(timestamp: number | null): Date | null {
  return timestamp ? new Date(timestamp) : null;
}

// Helper to convert Date to database timestamp
export function toTimestamp(date: Date | null): number | null {
  return date ? date.getTime() : null;
}

