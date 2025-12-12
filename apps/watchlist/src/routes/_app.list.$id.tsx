import { useAutoAnimate } from '@formkit/auto-animate/react';
import { createFileRoute, Link, useSearch } from '@tanstack/react-router';
import { zodValidator } from '@tanstack/zod-adapter';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckIcon,
  Clock4Icon,
  EllipsisVertical,
  HashIcon,
  PlusIcon,
  SettingsIcon,
  ShuffleIcon,
  SquareDashed,
  SquareDashedMousePointerIcon,
  StarIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { z } from 'zod';
import { AddMovieDialog } from '@/components/add-movie-dialog';
import { AppHeader, ProjectSelector, UserAvatarDropdown } from '@/components/app-layout';
import { EditItemDialog } from '@/components/edit-item-dialog';
import {
  ListItemCard,
  optimisticallyUpdateItem,
  optimisticallyUpdateItems,
  priorityColors,
  useIsSelectionMode,
} from '@/components/list-item';
import { ListSettingsSheet } from '@/components/list-settings-sheet';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { trpc } from '@/trpc';
import { cn } from '@/utils/cn';
import { lastOpenedList } from '@/utils/last-opened-list';
import { ListEventsProvider, useListEvent } from '@/utils/list-events';
import { ListStoreProvider, useListStore } from '@/utils/list-store';
import { useListId } from '@/utils/use-list-id';
import { itemsFilterSchema, useSortedAndFilteredListItemsSelector } from '@/utils/use-list-items';
import { useUser } from '@/utils/use-user';

export const Route = createFileRoute('/_app/list/$id')({
  component: RouteComponent,
  validateSearch: zodValidator(itemsFilterSchema),
  loaderDeps: () => ({}),
  shouldReload: false,
  loader: async ({ params, context }) => {
    lastOpenedList.set(params.id);

    await Promise.all([
      context.trpc.list.getItems.prefetch({ listId: params.id }),
      context.trpc.list.getLists.prefetch(),
    ]);

    return {
      listId: params.id,
    };
  },
});

type SortingOptions = z.infer<typeof itemsFilterSchema>;

function ListSettings() {
  const listId = useListId();
  return (
    <ListSettingsSheet listId={listId} asChild>
      <Button variant="ghost" size="icon" className="size-10 rounded-full">
        <SettingsIcon className="size-6! text-gray-400" />
      </Button>
    </ListSettingsSheet>
  );
}

function RouteComponent() {
  const listId = useListId();
  const user = useUser();

  return (
    <ListEventsProvider listId={listId} sessionId={user.sessionId}>
      <ListStoreProvider listId={listId}>
        <AppHeader>
          <div className="flex items-center gap-2">
            <ProjectSelector />
            <ListSettings />
          </div>
          <ListUsers />
        </AppHeader>
        <AddItemButton />
        <div className="sticky top-0 z-10 flex items-center justify-center bg-background/80 pb-2 backdrop-blur-md">
          <div className="grid w-full max-w-7xl grid-cols-[1fr_auto] items-center justify-start gap-x-4 gap-y-1 px-4 pt-2 sm:grid-cols-[auto_1fr_auto]">
            <SortingHeader />
            <SearchInput className="max-sm:col-span-2 max-sm:row-start-2 sm:max-w-52" />
            <HeaderMenu />
          </div>
        </div>
        <div className="flex w-full flex-col items-center">
          <ItemsList />
        </div>
      </ListStoreProvider>
    </ListEventsProvider>
  );
}

function ListUsers() {
  const user = useUser();
  const [connectedUsers, setConnectedUsers] = useState<{ id: string; name: string }[]>([]);
  useListEvent('users-updated', ({ users }) => {
    setConnectedUsers(users.filter((x) => x.id !== user.id));
  });
  return (
    <div className="flex items-center gap-2">
      {connectedUsers.map((user) => (
        <Avatar key={user.id}>
          <AvatarFallback>{user.name.slice(0, 2)}</AvatarFallback>
        </Avatar>
      ))}
      {connectedUsers.length > 0 && <Separator orientation="vertical" className="h-8" />}
      <UserAvatarDropdown />
    </div>
  );
}

const sortOrderIcon: Record<SortingOptions['sortOrder'], React.ReactNode> = {
  asc: <ArrowUpIcon />,
  desc: <ArrowDownIcon />,
};

const sortByIcon: Record<SortingOptions['sortBy'], React.ReactNode> = {
  duration: <Clock4Icon />,
  rating: <StarIcon />,
  dateAdded: <CalendarIcon />,
  priority: <HashIcon />,
};

const sortByLabel: Record<SortingOptions['sortBy'], string> = {
  duration: 'Duration',
  rating: 'Rating',
  dateAdded: 'Date Added',
  priority: 'Priority',
};

type SortingByOptionProps = {
  sortBy: SortingOptions['sortBy'];
};
function SortingOption({ sortBy }: SortingByOptionProps) {
  return (
    <DropdownMenuItem asChild className="w-full justify-between">
      <Link to="." search={(prev) => ({ ...prev, sortBy })}>
        <div className="flex items-center gap-2">
          {sortByIcon[sortBy]}
          <span>{sortByLabel[sortBy]}</span>
        </div>
      </Link>
    </DropdownMenuItem>
  );
}

function HeaderMenu({ className }: { className?: string }) {
  const selectAllItems = useListStore((state) => state.selectItems);
  const clearSelectedItems = useListStore((state) => state.clearSelectedItems);
  const isSelectionMode = useIsSelectionMode();
  const isRandomizedItem = useListStore((state) => !!state.randomizedItem);

  const selectRandomFromSelectedItems = useListStore((state) => state.selectRandomFromSelectedItems);
  const clearRandomizedItem = useListStore((state) => state.clearRandomizedItem);

  const listId = useListId();
  const { data: listItems = [] } = trpc.list.getItems.useQuery({ listId });
  const allItems = useMemo(() => listItems.map((x) => x.id), [listItems]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild className={cn('shrink-0', className)}>
        <Button variant="outline" size="icon">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {isSelectionMode ? (
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              clearSelectedItems();
            }}
          >
            <SquareDashed /> Clear selection
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              selectAllItems(allItems);
            }}
          >
            <SquareDashedMousePointerIcon /> Select all
          </DropdownMenuItem>
        )}
        {isSelectionMode && !isRandomizedItem && (
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              selectRandomFromSelectedItems();
            }}
          >
            <ShuffleIcon /> Select random
          </DropdownMenuItem>
        )}
        {isRandomizedItem && (
          <DropdownMenuItem
            onClick={(e) => {
              e.preventDefault();
              clearRandomizedItem();
            }}
          >
            <CheckIcon /> Clear randomized
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortingHeader({ className }: { className?: string }) {
  const { sortBy, sortOrder } = useSearch({ from: '/_app/list/$id' });

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {sortByIcon[sortBy]}
            <span>{sortByLabel[sortBy]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <SortingOption sortBy="duration" />
          <SortingOption sortBy="dateAdded" />
          <SortingOption sortBy="rating" />
          <SortingOption sortBy="priority" />
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="icon" asChild>
        <Link to="." search={(prev) => ({ ...prev, sortOrder: sortOrder === 'asc' ? 'desc' : 'asc' })}>
          {sortOrderIcon[sortOrder]}
        </Link>
      </Button>
      <FilterButton />
    </div>
  );
}

function FilterButton() {
  const { priority } = useSearch({ from: '/_app/list/$id' });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={priority === 'any' ? undefined : priorityColors[priority].text}
        >
          {priority === 'any' ? <HashIcon /> : priorityColors[priority].icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: 'high' })} className={priorityColors.high.text}>
            {priorityColors.high.icon}
            High
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: 'normal' })} className={priorityColors.normal.text}>
            {priorityColors.normal.icon}
            Normal
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: 'low' })} className={priorityColors.low.text}>
            {priorityColors.low.icon}
            Low
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: 'any' })}>
            <HashIcon /> Any
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchInput({ className }: { className?: string }) {
  const searchQuery = useListStore((state) => state.searchQuery);
  const setSearchQuery = useListStore((state) => state.setSearchQuery);

  return (
    <Input
      placeholder="Search..."
      className={className}
      value={searchQuery}
      onChange={(e) => setSearchQuery(e.target.value)}
    />
  );
}

function AddItemButton() {
  const listId = useListId();

  const { data: listItems = [] } = trpc.list.getItems.useQuery({ listId });
  const alreadyAddedItems = useMemo(() => listItems.map((x) => x.tmdbId).filter((id) => id !== null), [listItems]);

  return (
    <AddMovieDialog listId={listId} alreadyAddedItems={alreadyAddedItems} asChild>
      <Button variant="default" size="icon" className="fixed right-4 bottom-4 z-50 size-10 rounded-full">
        <PlusIcon className="size-6!" />
      </Button>
    </AddMovieDialog>
  );
}

function ItemsList() {
  const listId = useListId();
  const { data: items } = trpc.list.getItems.useQuery({ listId });

  const orderedItems = useSortedAndFilteredListItemsSelector(items ?? []);

  const [animateRef] = useAutoAnimate();

  useListEvents({ listId });

  return (
    <>
      {items && <EditItemDialog items={items} listId={listId} />}
      <div
        className="flex w-full max-w-7xl flex-wrap justify-center gap-4 px-4 pt-2 pb-20 md:grid md:grid-cols-2 xl:grid-cols-3"
        ref={animateRef}
      >
        {orderedItems.map((item) => (
          <ListItemCard key={item.id} item={item} listId={listId} />
        ))}
      </div>
    </>
  );
}

function useListEvents({ listId }: { listId: string }) {
  const utils = trpc.useUtils();

  useListEvent('item-created', ({ item }) => {
    optimisticallyUpdateItems(utils, listId, (items) => [
      {
        ...item,
        tags: [],
      },
      ...items,
    ]);
  });

  useListEvent('item-updated', ({ item }) => {
    optimisticallyUpdateItem(utils, listId, item.id, (oldItem) => ({
      ...oldItem,
      ...item,
    }));
  });

  useListEvent('item-removed', ({ itemId }) => {
    optimisticallyUpdateItems(utils, listId, (items) => items.filter((i) => i.id !== itemId));
  });
}
