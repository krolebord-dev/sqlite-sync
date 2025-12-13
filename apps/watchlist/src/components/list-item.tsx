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
  SkullIcon,
  ThumbsUpIcon,
  TrashIcon,
} from 'lucide-react';
import { useListDb } from '@/db';
import type { UiListItem } from '@/db/use-list-items';
import { cn } from '@/utils/cn';
import { formatDuration } from '@/utils/format-duration';
import { useListStore } from '@/utils/list-store';
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

type ListItem = UiListItem;

export function ListItemCard({ item, listId }: { item: ListItem; listId: string }) {
  const isWatched = !!item.watchedAt;
  const isSelected = useIsItemSelected(item.id);
  const isRandomizedItem = useIsRandomizedItem(item.id);

  const toggleItemSelection = useListStore((state) => state.toggleItemSelection);

  const { setWatched } = useListDb();

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
                  onClick={() => setWatched(item.id, true)}
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
    </DynamicMenuContent>
  );
}

type ItemMenuActioProps = {
  item: ListItem;
};

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
  const { removeItem } = useListDb();

  return (
    <DynamicMenuItem onClick={() => removeItem(item.id)}>
      <TrashIcon />
      Delete
    </DynamicMenuItem>
  );
}

function SetWatchedMenuItem({ item }: ItemMenuActioProps) {
  const isWatched = !!item.watchedAt;
  const { setWatched } = useListDb();

  return isWatched ? (
    <DynamicMenuItem onClick={() => setWatched(item.id, false)}>
      <EyeOffIcon />
      <span>Mark as unwatched</span>
    </DynamicMenuItem>
  ) : (
    <DynamicMenuItem onClick={() => setWatched(item.id, true)}>
      <CheckIcon />
      Mark as watched
    </DynamicMenuItem>
  );
}

function SetPriorityMenuItem({ item }: ItemMenuActioProps) {
  const { setPriority } = useListDb();

  return (
    <DynamicMenuSub>
      <DynamicMenuSubTrigger>
        <HashIcon />
        Set priority
      </DynamicMenuSubTrigger>
      <DynamicMenuSubContent>
        <DynamicMenuItem onClick={() => setPriority(item.id, 1)}>
          {priorityColors.high.icon}
          High
        </DynamicMenuItem>
        <DynamicMenuItem onClick={() => setPriority(item.id, 0)}>
          {priorityColors.normal.icon}
          Normal
        </DynamicMenuItem>
        <DynamicMenuItem onClick={() => setPriority(item.id, -1)}>
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
