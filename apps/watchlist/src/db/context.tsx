import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { generateId } from '@sqlite-sync/core';
import { initListDb, type ListDbInstance, useDb as useDbBase, useDbQuery as useDbQueryBase, DbProvider as DbProviderBase } from './list-db';
import type { ListDatabase, ListItemWithTags } from './schema';

// Re-export the base hooks
export { useDbQuery } from './list-db';

// Context for list-specific database operations
type ListDbContextValue = {
  db: ListDbInstance;
  listId: string;
  // Helper methods for common operations
  addItem: (item: Omit<ListItemWithTags, 'id' | 'tags' | 'created_at'>) => string;
  updateItem: (id: string, updates: Partial<ListItemWithTags>) => void;
  removeItem: (id: string) => void;
  setWatched: (id: string, watched: boolean) => void;
  setPriority: (id: string, priority: number) => void;
};

const ListDbContext = createContext<ListDbContextValue | null>(null);

/**
 * Hook to get the list database context with helper methods
 */
export function useListDb() {
  const context = useContext(ListDbContext);
  if (!context) {
    throw new Error('useListDb must be used within a ListDbProvider');
  }
  return context;
}

/**
 * Hook to access the raw database instance
 * Re-exported from the base for convenience
 */
export function useDb() {
  return useDbBase();
}

type ListDbProviderProps = {
  listId: string;
  sessionId: string;
  children: ReactNode;
  fallback?: ReactNode;
};

/**
 * Provider component that initializes the database for a specific list
 */
export function ListDbProvider({ listId, sessionId, children, fallback }: ListDbProviderProps) {
  const [db, setDb] = useState<ListDbInstance | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    initListDb(listId, sessionId)
      .then((db) => {
        if (!cancelled) {
          setDb(db);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to initialize list database:', err);
          setError(err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [listId, sessionId]);

  if (error) {
    return <div className="p-4 text-red-500">Failed to initialize database: {error.message}</div>;
  }

  if (!db) {
    return <>{fallback ?? <div className="p-4">Loading database...</div>}</>;
  }

  return (
    <DbProviderBase db={db}>
      <ListDbContextInner db={db} listId={listId}>
        {children}
      </ListDbContextInner>
    </DbProviderBase>
  );
}

/**
 * Inner context that provides helper methods
 */
function ListDbContextInner({
  db,
  listId,
  children,
}: {
  db: ListDbInstance;
  listId: string;
  children: ReactNode;
}) {
  const contextValue: ListDbContextValue = {
    db,
    listId,

    addItem: (item) => {
      const id = generateId();
      const now = Date.now();

      db.db.executeKysely((kysely) =>
        kysely.insertInto('_list_items').values({
          id,
          type: item.type,
          tmdb_id: item.tmdb_id,
          title: item.title,
          poster_url: item.poster_url,
          overview: item.overview,
          duration: item.duration,
          episode_count: item.episode_count,
          rating: item.rating,
          release_date: item.release_date,
          watched_at: item.watched_at,
          priority: item.priority,
          created_at: now,
          tombstone: false,
        }),
      );
      db.reactiveDb.notifyTableSubscribers(['list_items', '_list_items']);

      return id;
    },

    updateItem: (id, updates) => {
      const updateValues: Record<string, unknown> = {};

      if (updates.title !== undefined) updateValues.title = updates.title;
      if (updates.type !== undefined) updateValues.type = updates.type;
      if (updates.tmdb_id !== undefined) updateValues.tmdb_id = updates.tmdb_id;
      if (updates.poster_url !== undefined) updateValues.poster_url = updates.poster_url;
      if (updates.overview !== undefined) updateValues.overview = updates.overview;
      if (updates.duration !== undefined) updateValues.duration = updates.duration;
      if (updates.episode_count !== undefined) updateValues.episode_count = updates.episode_count;
      if (updates.rating !== undefined) updateValues.rating = updates.rating;
      if (updates.release_date !== undefined) updateValues.release_date = updates.release_date;
      if (updates.watched_at !== undefined) updateValues.watched_at = updates.watched_at;
      if (updates.priority !== undefined) updateValues.priority = updates.priority;

      if (Object.keys(updateValues).length > 0) {
        db.db.executeKysely((kysely) =>
          kysely.updateTable('_list_items').set(updateValues).where('id', '=', id),
        );
        db.reactiveDb.notifyTableSubscribers(['list_items', '_list_items']);
      }
    },

    removeItem: (id) => {
      // Soft delete using tombstone
      db.db.executeKysely((kysely) =>
        kysely.updateTable('_list_items').set({ tombstone: true }).where('id', '=', id),
      );
      db.reactiveDb.notifyTableSubscribers(['list_items', '_list_items']);
    },

    setWatched: (id, watched) => {
      const watchedAt = watched ? Date.now() : null;
      db.db.executeKysely((kysely) =>
        kysely.updateTable('_list_items').set({ watched_at: watchedAt }).where('id', '=', id),
      );
      db.reactiveDb.notifyTableSubscribers(['list_items', '_list_items']);
    },

    setPriority: (id, priority) => {
      db.db.executeKysely((kysely) =>
        kysely.updateTable('_list_items').set({ priority }).where('id', '=', id),
      );
      db.reactiveDb.notifyTableSubscribers(['list_items', '_list_items']);
    },
  };

  return <ListDbContext.Provider value={contextValue}>{children}</ListDbContext.Provider>;
}

