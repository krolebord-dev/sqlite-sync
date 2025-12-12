import { format } from 'date-fns';
import {
  CalendarIcon,
  CheckIcon,
  Clock4Icon,
  EllipsisVerticalIcon,
  EyeIcon,
  EyeOffIcon,
  FlameIcon,
  HashIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SkullIcon,
  ThumbsUpIcon,
  TrashIcon,
} from 'lucide-react';
import type { TrpcOutput } from '@/trpc';
import { trpc } from '@/trpc';
import { cn } from '@/utils/cn';
import { formatDuration } from '@/utils/format-duration';
import { useListStore } from '@/utils/list-store';
import { useListId } from '@/utils/use-list-id';
import { VoteAverage } from './movie-card';
import { Button } from './ui/button';
import { ContextMenu, ContextMenuTrigger } from './ui/context-menu';
import { DropdownMenu, DropdownMenuTrigger } from './ui/dropdown-menu';
import {
  DynamicMenuContent,
  type DynamicMenuContentType,
  DynamicMenuItem,
  DynamicMenuSub,
  DynamicMenuSubContent,
  DynamicMenuSubTrigger,
} from './ui/dynamic-menu-content';

type ListItem = TrpcOutput['list']['getItems'][number];
export function ListItemCard({ item, listId }: { item: ListItem; listId: string }) {
  const isWatched = !!item.watchedAt;
  const isSelected = useIsItemSelected(item.id);
  const isRandomizedItem = useIsRandomizedItem(item.id);

  const toggleItemSelection = useListStore((state) => state.toggleItemSelection);

  const setWatchedMutation = useSetWatchedMutation(listId);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group relative grid w-full grid-cols-3 items-stretch overflow-hidden rounded-md border border-border bg-card shadow-xs',
            isRandomizedItem && 'border-primary',
          )}
        >
          {item.posterUrl && (
            <img
              className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-30 blur-3xl"
              draggable={false}
              src={item.posterUrl}
              alt={item.title}
            />
          )}
          <div
            className={cn('relative aspect-2/3 w-full cursor-pointer self-center overflow-hidden')}
            onClick={() => {
              toggleItemSelection(item.id);
            }}
          >
            {item.posterUrl && (
              <img
                className="h-full w-full select-none object-cover"
                draggable={false}
                src={item.posterUrl}
                alt={item.title}
              />
            )}
            {item.rating && !isSelected && (
              <VoteAverage className="absolute top-2 left-2" voteAverage={item.rating / 10} />
            )}

            <PriorityBadge className="absolute bottom-2 left-2" priority={item.priority} />

            {(isWatched || isSelected) && (
              <div className="absolute top-0 left-0 flex h-full w-full items-center justify-center bg-black/50">
                {isWatched && <CheckIcon className="size-10! text-green-500" />}
              </div>
            )}
            {isSelected && (
              <p className="absolute top-2 left-2 flex size-8 select-none items-center justify-center rounded-full bg-primary text-white">
                <CheckIcon />
              </p>
            )}
          </div>

          <div className="col-span-2 flex flex-col justify-between p-4">
            <div className="flex flex-col gap-2">
              <a
                href={`https://www.google.com/search?q=${encodeURIComponent(item.title)}`}
                target="_blank"
                rel="noreferrer"
                tabIndex={-1}
                className="cursor-pointer truncate font-semibold"
              >
                {item.title}
              </a>
              <p className="flex flex-wrap gap-x-4 gap-y-2 text-muted-foreground text-sm">
                {!!item.releaseDate && (
                  <span className="flex items-center gap-1">
                    <CalendarIcon className="size-4!" /> {format(new Date(item.releaseDate), 'y')}
                  </span>
                )}
                {!!item.duration && (
                  <span className="flex items-center gap-1">
                    <Clock4Icon className="size-4!" /> {formatDuration(item.duration)}
                  </span>
                )}
                {item.type === 'tv' && !!item.episodeCount && (
                  <span className="flex items-center gap-1">
                    <HashIcon className="size-4!" /> {item.episodeCount}
                  </span>
                )}
                {isWatched && !!item.watchedAt && (
                  <span className="flex items-center gap-1">
                    <EyeIcon className="size-4!" /> {format(item.watchedAt, 'd MMM y')}
                  </span>
                )}
              </p>
              {item.tags && item.tags.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {item.tags.map((tag) => (
                    <span key={tag.id} className="rounded-full border border-border bg-card px-2 py-0.5 text-xs">
                      {tag.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              {!isWatched && (
                <Button
                  variant="ghost"
                  size="icon"
                  disabled={setWatchedMutation.isPending}
                  onClick={() => setWatchedMutation.mutate({ listId, itemId: item.id, watched: true })}
                >
                  <CheckIcon />
                </Button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon">
                    <EllipsisVerticalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <ListItemMenuContent type="dropdown-menu" item={item} />
              </DropdownMenu>
            </div>
          </div>
        </div>
      </ContextMenuTrigger>
      <ListItemMenuContent type="context-menu" item={item} />
    </ContextMenu>
  );
}

type ListItemMenuContentProps = {
  type: DynamicMenuContentType;
  item: ListItem;
};
function ListItemMenuContent({ type, item }: ListItemMenuContentProps) {
  return (
    <DynamicMenuContent type={type}>
      <ToggleItemSelectionMenuItem item={item} />
      <EditMenuItem item={item} />
      <DeleteMenuItem item={item} />
      <SetWatchedMenuItem item={item} />
      <SetPriorityMenuItem item={item} />
      <ReindexMenuItem item={item} />
    </DynamicMenuContent>
  );
}

type ItemMenuActioProps = {
  item: ListItem;
};

type Utils = ReturnType<typeof trpc.useUtils>;

export function optimisticallyUpdateItems(
  utils: Utils,
  listId: string,
  updateItems: (items: ListItem[]) => ListItem[],
) {
  const previousItems = utils.list.getItems.getData({ listId });
  utils.list.getItems.setData({ listId }, (old) => {
    return updateItems(old ?? []);
  });

  return { previousItems };
}

export function optimisticallyUpdateItem(
  utils: Utils,
  listId: string,
  itemId: string,
  updateItem: (item: ListItem) => Partial<ListItem>,
) {
  return optimisticallyUpdateItems(utils, listId, (old) => {
    const newItems = [...old];
    const itemIndex = newItems.findIndex((item) => item.id === itemId);
    if (itemIndex === -1) return newItems;

    newItems[itemIndex] = {
      ...newItems[itemIndex],
      ...updateItem(newItems[itemIndex]),
    };
    return newItems;
  });
}

function ToggleItemSelectionMenuItem({ item }: ItemMenuActioProps) {
  const isSelected = useIsItemSelected(item.id);
  const toggleItemSelection = useListStore((state) => state.toggleItemSelection);

  return (
    <DynamicMenuItem onClick={() => toggleItemSelection(item.id)}>
      {isSelected ? <MinusIcon /> : <PlusIcon />}
      <span>{isSelected ? 'Deselect' : 'Select'}</span>
    </DynamicMenuItem>
  );
}

function DeleteMenuItem({ item }: ItemMenuActioProps) {
  const listId = useListId();
  const utils = trpc.useUtils();
  const removeItemMutation = trpc.list.removeItem.useMutation({
    onMutate: ({ itemId }) =>
      optimisticallyUpdateItems(utils, listId, (old) => old.filter((item) => item.id !== itemId)),
    onError: (_, __, context) => {
      if (context?.previousItems) {
        utils.list.getItems.setData({ listId }, context.previousItems);
      }
    },
    onSuccess: () => {
      utils.list.getItems.invalidate({ listId });
    },
  });

  return (
    <DynamicMenuItem
      disabled={removeItemMutation.isPending}
      onClick={() => removeItemMutation.mutate({ listId, itemId: item.id })}
    >
      <TrashIcon />
      Delete
    </DynamicMenuItem>
  );
}

function useSetWatchedMutation(listId: string) {
  const utils = trpc.useUtils();

  return trpc.list.setWatched.useMutation({
    onMutate: ({ itemId, watched }) =>
      optimisticallyUpdateItem(utils, listId, itemId, () => ({ watchedAt: watched ? new Date() : null })),
    onError: (_, __, context) => {
      if (context?.previousItems) {
        utils.list.getItems.setData({ listId }, context.previousItems);
      }
    },
    onSuccess: () => {
      utils.list.getItems.invalidate({ listId });
    },
  });
}

function SetWatchedMenuItem({ item }: ItemMenuActioProps) {
  const isWatched = !!item.watchedAt;

  const listId = useListId();
  const setWatchedMutation = useSetWatchedMutation(listId);

  return isWatched ? (
    <DynamicMenuItem
      disabled={setWatchedMutation.isPending}
      onClick={() => setWatchedMutation.mutate({ listId, itemId: item.id, watched: false })}
    >
      <EyeOffIcon />
      <span>Mark as unwatched</span>
    </DynamicMenuItem>
  ) : (
    <DynamicMenuItem
      disabled={setWatchedMutation.isPending}
      onClick={() => setWatchedMutation.mutate({ listId, itemId: item.id, watched: true })}
    >
      <CheckIcon />
      Mark as watched
    </DynamicMenuItem>
  );
}

function ReindexMenuItem({ item }: ItemMenuActioProps) {
  const listId = useListId();
  const utils = trpc.useUtils();

  const reindexItemMutation = trpc.list.reindexItem.useMutation({
    onSuccess: () => {
      utils.list.getItems.invalidate({ listId });
    },
  });

  return (
    <DynamicMenuItem
      disabled={reindexItemMutation.isPending}
      onClick={() => reindexItemMutation.mutate({ listId, itemId: item.id })}
    >
      <RefreshCwIcon />
      Reindex
    </DynamicMenuItem>
  );
}

function SetPriorityMenuItem({ item }: ItemMenuActioProps) {
  const listId = useListId();
  const utils = trpc.useUtils();

  const setPriorityMutation = trpc.list.setPriority.useMutation({
    onMutate: ({ itemId, priority }) =>
      optimisticallyUpdateItem(utils, listId, itemId, () => ({ priority: getPriorityValue(priority) })),
    onError: (_, __, context) => {
      if (context?.previousItems) {
        utils.list.getItems.setData({ listId }, context.previousItems);
      }
    },
    onSuccess: () => {
      utils.list.getItems.invalidate({ listId });
    },
  });

  return (
    <DynamicMenuSub>
      <DynamicMenuSubTrigger disabled={setPriorityMutation.isPending}>
        <HashIcon />
        Set priority
      </DynamicMenuSubTrigger>
      <DynamicMenuSubContent>
        <DynamicMenuItem onClick={() => setPriorityMutation.mutate({ listId, itemId: item.id, priority: 'high' })}>
          {priorityColors.high.icon}
          High
        </DynamicMenuItem>
        <DynamicMenuItem onClick={() => setPriorityMutation.mutate({ listId, itemId: item.id, priority: 'normal' })}>
          {priorityColors.normal.icon}
          Normal
        </DynamicMenuItem>
        <DynamicMenuItem onClick={() => setPriorityMutation.mutate({ listId, itemId: item.id, priority: 'low' })}>
          {priorityColors.low.icon}
          Low
        </DynamicMenuItem>
      </DynamicMenuSubContent>
    </DynamicMenuSub>
  );
}

export function getPriorityLabel(priority: number) {
  if (priority === 0) return 'normal' as const;
  if (priority > 0) return 'high' as const;
  return 'low' as const;
}

function getPriorityValue(priority: string) {
  if (priority === 'high') return 1;
  if (priority === 'low') return -1;
  return 0;
}

export const priorityColors = {
  high: {
    bg: 'bg-orange-500',
    border: 'border-orange-500',
    text: 'text-orange-500',
    icon: <FlameIcon />,
  },
  normal: {
    bg: 'bg-blue-500',
    border: 'border-blue-500',
    text: 'text-blue-500',
    icon: <ThumbsUpIcon />,
  },
  low: {
    bg: 'bg-gray-500',
    border: 'border-gray-500',
    text: 'text-gray-500',
    icon: <SkullIcon />,
  },
};

export function PriorityBadge({ priority, className }: { priority: number; className: string }) {
  const { text, border, icon } = priorityColors[getPriorityLabel(priority)];

  return (
    <p
      className={cn(
        'flex size-8 select-none items-center justify-center rounded-full border-2 bg-black [&_svg]:size-5 [&_svg]:shrink-0',
        text,
        border,
        className,
      )}
    >
      {icon}
    </p>
  );
}

function useIsItemSelected(itemId: string) {
  return useListStore((state) => state.selectedItems.includes(itemId));
}

export function useIsSelectionMode() {
  return useListStore((state) => state.selectedItems.length > 0);
}

function useIsRandomizedItem(itemId: string) {
  return useListStore((state) => state.randomizedItem === itemId);
}

function EditMenuItem({ item }: ItemMenuActioProps) {
  const setEditItemId = useListStore((state) => state.setEditItemId);

  return (
    <DynamicMenuItem onClick={() => setEditItemId(item.id)}>
      <PencilIcon />
      Edit
    </DynamicMenuItem>
  );
}
