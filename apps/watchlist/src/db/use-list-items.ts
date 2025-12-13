import { useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import * as R from 'remeda';
import { z } from 'zod';
import { useDbQuery } from './list-db';
import { useListStore } from '@/utils/list-store';
import { toDate } from './schema';

export const itemsFilterSchema = z.object({
  sortBy: z.enum(['duration', 'rating', 'dateAdded', 'priority']).default('dateAdded'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  priority: z.enum(['high', 'normal', 'low', 'any']).default('any'),
});

export type SortingOptions = z.infer<typeof itemsFilterSchema>;

// Type for list item as returned from the database
export type DbListItem = {
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
};

// Type for list item with converted dates (matching the UI expectations)
export type UiListItem = {
  id: string;
  type: 'movie' | 'tv';
  tmdbId: number | null;
  title: string;
  posterUrl: string | null;
  overview: string | null;
  duration: number | null;
  episodeCount: number | null;
  rating: number | null;
  releaseDate: Date | null;
  watchedAt: Date | null;
  priority: number;
  createdAt: Date;
  tags: Array<{ id: string; name: string }>;
};

/**
 * Convert database item to UI item format
 */
export function dbItemToUiItem(item: DbListItem): UiListItem {
  return {
    id: item.id,
    type: item.type as 'movie' | 'tv',
    tmdbId: item.tmdb_id,
    title: item.title,
    posterUrl: item.poster_url,
    overview: item.overview,
    duration: item.duration,
    episodeCount: item.episode_count,
    rating: item.rating,
    releaseDate: toDate(item.release_date),
    watchedAt: toDate(item.watched_at),
    priority: item.priority,
    createdAt: new Date(item.created_at),
    tags: [], // TODO: Load tags from database
  };
}

/**
 * Hook to get all list items from the local SQLite database
 */
export function useListItems() {
  const { rows } = useDbQuery({
    queryFn: (db) =>
      db
        .selectFrom('list_items')
        .select([
          'id',
          'type',
          'tmdb_id',
          'title',
          'poster_url',
          'overview',
          'duration',
          'episode_count',
          'rating',
          'release_date',
          'watched_at',
          'priority',
          'created_at',
        ])
        .where('tombstone', '=', false)
        .orderBy('created_at', 'desc'),
  });

  // Convert to UI format
  return useMemo(() => rows.map(dbItemToUiItem), [rows]);
}

/**
 * Hook to get already added TMDB IDs (for preventing duplicates in search)
 */
export function useAlreadyAddedTmdbIds() {
  const { rows } = useDbQuery({
    queryFn: (db) =>
      db
        .selectFrom('list_items')
        .select('tmdb_id')
        .where('tombstone', '=', false)
        .where('tmdb_id', 'is not', null),
  });

  return useMemo(() => rows.map((r) => r.tmdb_id).filter((id): id is number => id !== null), [rows]);
}

export function getPriorityLabel(priority: number) {
  if (priority === 0) return 'normal' as const;
  if (priority > 0) return 'high' as const;
  return 'low' as const;
}

/**
 * Hook to get sorted and filtered list items based on current filters
 */
export function useSortedAndFilteredListItems() {
  const items = useListItems();
  const { sortBy, sortOrder, priority } = useSearch({ from: '/_app/list/$id' });

  const randomizedItem = useListStore((x) => x.randomizedItem);
  const searchQuery = useListStore((x) => x.searchQuery);

  return useMemo(() => {
    if (!items) {
      return [];
    }

    return R.pipe(
      items,
      R.filter((x) => (searchQuery ? x.title.toLowerCase().includes(searchQuery.toLowerCase()) : true)),
      R.filter((x) => priority === 'any' || getPriorityLabel(x.priority) === priority),
      R.sortBy(
        [(x) => (x.id === randomizedItem ? -1 : 1), 'asc'],
        [(x) => (x.watchedAt ? 1 : 0), 'asc'],
        [
          (x) => {
            switch (sortBy) {
              case 'dateAdded':
                return x.watchedAt ? x.watchedAt.getTime() : x.createdAt.getTime();
              case 'duration':
                return x.duration ?? Number.MAX_SAFE_INTEGER;
              case 'priority':
                return x.priority;
              case 'rating':
                return x.rating ?? Number.MAX_SAFE_INTEGER;
              default:
                sortBy satisfies never;
                return x.createdAt.getTime();
            }
          },
          sortOrder,
        ],
      ),
    );
  }, [items, sortBy, sortOrder, searchQuery, randomizedItem, priority]);
}

