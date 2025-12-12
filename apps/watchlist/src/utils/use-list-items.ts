import { useSearch } from '@tanstack/react-router';
import { useMemo } from 'react';
import * as R from 'remeda';
import { z } from 'zod';
import { getPriorityLabel } from '@/components/list-item';
import type { TrpcOutput } from '@/trpc';
import { useListStore } from './list-store';

export const itemsFilterSchema = z.object({
  sortBy: z.enum(['duration', 'rating', 'dateAdded', 'priority']).default('dateAdded'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  priority: z.enum(['high', 'normal', 'low', 'any']).default('any'),
});

export function useSortedAndFilteredListItemsSelector(items: TrpcOutput['list']['getItems']) {
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
