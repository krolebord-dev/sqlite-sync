import type { SyncedDb } from "@sqlite-sync/core";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { useAtomValue, useSetAtom } from "jotai";
import {
  AlertCircleIcon,
  CalendarIcon,
  CheckIcon,
  Clock4Icon,
  EllipsisVerticalIcon,
  EyeIcon,
  EyeOffIcon,
  FlameIcon,
  FrownIcon,
  HashIcon,
  LoaderCircleIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  SkullIcon,
  StarIcon,
  StarsIcon,
  ThumbsUpIcon,
  TrashIcon,
  TvIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  DynamicMenuContent,
  type DynamicMenuContentType,
  DynamicMenuItem,
  DynamicMenuSub,
  DynamicMenuSubContent,
  DynamicMenuSubTrigger,
} from "@/components/ui/dynamic-menu-content";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils/format-duration";
import { useDb } from "@/list-db/list-db";
import { useListOrpc } from "@/list-db/list-orpc-context";
import type { ListDb, ListItem } from "@/list-db/migrations";
import {
  editItemAtom,
  type ItemWatchProviders,
  isItemSelectedAtom,
  isRandomizedItemAtom,
  itemWatchProvidersAtom,
  loadingWatchProvidersAtom,
  reviewItemAtom,
  toggleItemSelectionAtom,
} from "./list-atoms";

export const ListItemCard = memo(({ item }: { item: ListItem }) => {
  const isTouchDevice = useIsTouchDevice();
  return (
    <ContextMenu>
      <ListItemCardDisplay item={item} disableContextMenu={isTouchDevice} />
      {!isTouchDevice && <ListItemMenuContent type="context-menu" item={item} />}
    </ContextMenu>
  );
});

export const ListItemCardDisplay = ({ item, disableContextMenu = false }: { item: ListItem; disableContextMenu?: boolean }) => {
  const isWatched = !!item.watchedAt;
  const isSelected = useIsItemSelected(item.id);
  const isRandomizedItem = useIsRandomizedItem(item.id);

  const toggleItemSelection = useSetAtom(toggleItemSelectionAtom);
  const handleToggleSelection = useCallback(() => toggleItemSelection(item.id), [toggleItemSelection, item.id]);

  const tags = useMemo(() => JSON.parse(item.tags) as string[], [item.tags]);
  const tagHighlights = useMemo(() => {
    try {
      return JSON.parse(item.tagHighlights) as Record<string, "positive" | "negative">;
    } catch {
      return {} as Record<string, "positive" | "negative">;
    }
  }, [item.tagHighlights]);
  const maxTags = 4;
  const visibleTags = tags.slice(0, maxTags);
  const hiddenTags = tags.slice(maxTags);
  const remainingTagCount = hiddenTags.length;

  return (
    <ContextMenuTrigger
      disabled={disableContextMenu}
      className={cn(
        "group relative grid w-full grid-cols-3 items-stretch overflow-hidden rounded-md border border-border bg-card shadow-xs",
        isRandomizedItem && "border-primary",
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
        className={cn("relative aspect-2/3 w-full cursor-pointer self-center overflow-hidden")}
        onClick={handleToggleSelection}
      >
        {item.posterUrl && (
          <img
            className="h-full w-full select-none object-cover"
            draggable={false}
            src={item.posterUrl}
            alt={item.title}
          />
        )}
        {item.rating && !isSelected && <VoteAverage className="absolute top-2 left-2" voteAverage={item.rating} />}

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
                <CalendarIcon className="size-4!" /> {format(new Date(item.releaseDate), "y")}
              </span>
            )}
            {!!item.duration && (
              <span className="flex items-center gap-1">
                <Clock4Icon className="size-4!" /> {formatDuration(item.duration)}
              </span>
            )}
            {item.type === "tv" && !!item.episodeCount && (
              <span className="flex items-center gap-1">
                <HashIcon className="size-4!" /> {item.episodeCount}
              </span>
            )}
            {isWatched && !!item.watchedAt && (
              <span className="flex items-center gap-1">
                <EyeIcon className="size-4!" /> {format(item.watchedAt, "d MMM y")}
              </span>
            )}
          </p>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {visibleTags.map((tag) => {
                const hl = tagHighlights[tag];
                return (
                  <span
                    key={tag}
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      hl === "positive" && "border-green-500 bg-green-500/20 text-green-400",
                      hl === "negative" && "border-red-500 bg-red-500/20 text-red-400",
                      hl === undefined && "border-border bg-card/80 text-foreground",
                    )}
                  >
                    {tag}
                  </span>
                );
              })}
              {remainingTagCount > 0 && (
                <Tooltip>
                  <TooltipTrigger className="cursor-default select-none rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                    <span title={hiddenTags.join(", ")}>+{remainingTagCount}</span>
                  </TooltipTrigger>
                  <TooltipContent sideOffset={6}>{hiddenTags.join(", ")}</TooltipContent>
                </Tooltip>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2">
          <ProcessingStatusIndicator status={item.processingStatus} />
          <WatchProvidersInline item={item} />
          <RatingButton item={item} />
          <DropdownMenu>
            <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "icon" })}>
              <EllipsisVerticalIcon />
            </DropdownMenuTrigger>
            <ListItemMenuContent type="dropdown-menu" item={item} />
          </DropdownMenu>
        </div>
      </div>
    </ContextMenuTrigger>
  );
};

function useIsTouchDevice() {
  const [isTouchDevice, setIsTouchDevice] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mediaQuery = window.matchMedia("(hover: none) and (pointer: coarse)");
    const update = () => setIsTouchDevice(mediaQuery.matches);
    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, []);

  return isTouchDevice;
}

type ListItemMenuContentProps = {
  type: DynamicMenuContentType;
  item: ListItem;
};
const ListItemMenuContent = memo(({ type, item }: ListItemMenuContentProps) => {
  return (
    <DynamicMenuContent type={type}>
      <ToggleItemSelectionMenuItem item={item} />
      <EditMenuItem item={item} />
      <DeleteMenuItem item={item} />
      <SetWatchedMenuItem item={item} />
      <SetPriorityMenuItem item={item} />
      <AiSuggestTagsMenuItem item={item} />
      <LoadWatchProvidersMenuItem item={item} />
    </DynamicMenuContent>
  );
});

type ItemMenuActioProps = {
  item: ListItem;
};

function ToggleItemSelectionMenuItem({ item }: ItemMenuActioProps) {
  const isSelected = useIsItemSelected(item.id);
  const toggleItemSelection = useSetAtom(toggleItemSelectionAtom);

  return (
    <DynamicMenuItem onClick={() => toggleItemSelection(item.id)}>
      {isSelected ? <MinusIcon /> : <PlusIcon />}
      <span>{isSelected ? "Deselect" : "Select"}</span>
    </DynamicMenuItem>
  );
}

function DeleteMenuItem({ item }: ItemMenuActioProps) {
  const db = useDb();
  const deleteItem = (itemId: string) => {
    db.db.executeKysely((db) => db.deleteFrom("item").where("id", "=", itemId));
  };

  return (
    <DynamicMenuItem onClick={() => deleteItem(item.id)}>
      <TrashIcon />
      Delete
    </DynamicMenuItem>
  );
}

function setWatchedMutation(db: SyncedDb<ListDb>, itemId: string, watched: boolean) {
  db.db.executeKysely((db) =>
    db
      .updateTable("item")
      .set({ watchedAt: watched ? Date.now() : null })
      .where("id", "=", itemId),
  );
}

function SetWatchedMenuItem({ item }: ItemMenuActioProps) {
  const db = useDb();
  const isWatched = !!item.watchedAt;
  const setReviewItem = useSetAtom(reviewItemAtom);

  return isWatched ? (
    <DynamicMenuItem onClick={() => setWatchedMutation(db, item.id, false)}>
      <EyeOffIcon />
      <span>Mark as unwatched</span>
    </DynamicMenuItem>
  ) : (
    <DynamicMenuItem
      onClick={() => {
        setWatchedMutation(db, item.id, true);
        setReviewItem(item.id);
      }}
    >
      <CheckIcon />
      Mark as watched
    </DynamicMenuItem>
  );
}

function RatingButton({ item }: { item: ListItem }) {
  const db = useDb();
  const isWatched = !!item.watchedAt;
  const setReviewItem = useSetAtom(reviewItemAtom);

  if (!isWatched) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => {
          setWatchedMutation(db, item.id, true);
          setReviewItem(item.id);
        }}
      >
        <CheckIcon />
      </Button>
    );
  }

  if (item.userRating != null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="relative" onClick={() => setReviewItem(item.id)}>
            <StarIcon className="size-5 fill-yellow-500 text-yellow-500" />
            <span className="absolute -right-1 -bottom-1 rounded-full bg-background px-1 font-bold text-[10px] text-yellow-500 leading-tight">
              {item.userRating % 1 === 0 ? item.userRating : item.userRating.toFixed(1)}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>Edit review</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={() => setReviewItem(item.id)}>
          <StarIcon className="size-5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>Rate</TooltipContent>
    </Tooltip>
  );
}

const useIsItemSelected = (itemId: string) => useAtomValue(isItemSelectedAtom(itemId));

const useIsRandomizedItem = (itemId: string) => useAtomValue(isRandomizedItemAtom(itemId));

function SetPriorityMenuItem({ item }: ItemMenuActioProps) {
  const db = useDb();

  const setPriority = (itemId: string, priority: "high" | "low" | "normal") => {
    db.db.executeKysely((db) =>
      db
        .updateTable("item")
        .set({ priority: getPriorityValue(priority) })
        .where("id", "=", itemId),
    );
  };

  return (
    <DynamicMenuSub>
      <DynamicMenuSubTrigger>
        <HashIcon />
        Set priority
      </DynamicMenuSubTrigger>
      <DynamicMenuSubContent>
        <DynamicMenuItem onClick={() => setPriority(item.id, "high")}>
          {priorityColors.high.icon}
          High
        </DynamicMenuItem>
        <DynamicMenuItem onClick={() => setPriority(item.id, "normal")}>
          {priorityColors.normal.icon}
          Normal
        </DynamicMenuItem>
        <DynamicMenuItem onClick={() => setPriority(item.id, "low")}>
          {priorityColors.low.icon}
          Low
        </DynamicMenuItem>
      </DynamicMenuSubContent>
    </DynamicMenuSub>
  );
}

export function getPriorityLabel(priority: number) {
  if (priority === 0) return "normal" as const;
  if (priority > 0) return "high" as const;
  return "low" as const;
}

export function getPriorityValue(priority: "high" | "low" | "normal") {
  if (priority === "high") return 1;
  if (priority === "low") return -1;
  return 0;
}

export const priorityColors = {
  high: {
    bg: "bg-orange-500",
    border: "border-orange-500",
    text: "text-orange-500",
    icon: <FlameIcon />,
  },
  normal: {
    bg: "bg-blue-500",
    border: "border-blue-500",
    text: "text-blue-500",
    icon: <ThumbsUpIcon />,
  },
  low: {
    bg: "bg-gray-500",
    border: "border-gray-500",
    text: "text-gray-500",
    icon: <SkullIcon />,
  },
};

export function PriorityBadge({ priority, className }: { priority: number; className: string }) {
  const { text, border, icon } = priorityColors[getPriorityLabel(priority)];

  return (
    <p
      className={cn(
        "flex size-8 select-none items-center justify-center rounded-full border-2 bg-black [&_svg]:size-5 [&_svg]:shrink-0",
        text,
        border,
        className,
      )}
    >
      {icon}
    </p>
  );
}

function EditMenuItem({ item }: ItemMenuActioProps) {
  const setEditItemId = useSetAtom(editItemAtom);

  return (
    <DynamicMenuItem onClick={() => setEditItemId(item.id)}>
      <PencilIcon />
      Edit
    </DynamicMenuItem>
  );
}

function AiSuggestTagsMenuItem({ item }: ItemMenuActioProps) {
  const listDbOrpc = useListOrpc();
  const db = useDb();
  const suggestTagsMutation = useMutation(
    listDbOrpc.aiSuggestions.suggestTags.mutationOptions({
      onMutate: () => {
        db.db.executeKysely((db) =>
          db.updateTable("item").set({ processingStatus: "pending" }).where("id", "=", item.id),
        );
      },
    }),
  );

  return (
    <DynamicMenuItem onClick={() => suggestTagsMutation.mutate({ itemId: item.id })}>
      <StarsIcon />
      Suggest Tags
    </DynamicMenuItem>
  );
}

function LoadWatchProvidersMenuItem({ item }: ItemMenuActioProps) {
  const listOrpc = useListOrpc();
  const setWatchProviders = useSetAtom(itemWatchProvidersAtom);
  const setLoading = useSetAtom(loadingWatchProvidersAtom);

  const loadProvidersMutation = useMutation(
    listOrpc.watchProviders.getItemWatchProviders.mutationOptions({
      onMutate: () => {
        setLoading((prev: Set<string>) => new Set(prev).add(item.id));
      },
      onSuccess: (data) => {
        if (data.link) {
          setWatchProviders((prev: Record<string, ItemWatchProviders>) => ({
            ...prev,
            [item.id]: { link: data.link as string, providers: data.providers },
          }));
        }
        setLoading((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      },
      onError: () => {
        setLoading((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      },
    }),
  );

  return (
    <DynamicMenuItem onClick={() => loadProvidersMutation.mutate({ tmdbId: item.tmdbId, type: item.type })}>
      <TvIcon />
      Watch Providers
    </DynamicMenuItem>
  );
}

function WatchProvidersInline({ item }: { item: ListItem }) {
  const listOrpc = useListOrpc();
  const watchProvidersMap = useAtomValue(itemWatchProvidersAtom);
  const loadingSet = useAtomValue(loadingWatchProvidersAtom);
  const setWatchProviders = useSetAtom(itemWatchProvidersAtom);
  const setLoading = useSetAtom(loadingWatchProvidersAtom);

  const isLoading = loadingSet.has(item.id);
  const data = watchProvidersMap[item.id];

  const loadProvidersMutation = useMutation(
    listOrpc.watchProviders.getItemWatchProviders.mutationOptions({
      onMutate: () => {
        setLoading((prev: Set<string>) => new Set(prev).add(item.id));
      },
      onSuccess: (data) => {
        if (data.link) {
          setWatchProviders((prev: Record<string, ItemWatchProviders>) => ({
            ...prev,
            [item.id]: { link: data.link as string, providers: data.providers },
          }));
        } else {
          setWatchProviders((prev: Record<string, ItemWatchProviders>) => ({
            ...prev,
            [item.id]: { link: "", providers: [] },
          }));
        }
        setLoading((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      },
      onError: () => {
        setLoading((prev: Set<string>) => {
          const next = new Set(prev);
          next.delete(item.id);
          return next;
        });
      },
    }),
  );

  const handleLoad = useCallback(() => {
    loadProvidersMutation.mutate({ tmdbId: item.tmdbId, type: item.type });
  }, [loadProvidersMutation, item.tmdbId, item.type]);

  if (isLoading) {
    return (
      <Button variant="ghost" size="icon" disabled>
        <LoaderCircleIcon className="animate-spin" />
      </Button>
    );
  }

  if (data) {
    if (data.providers.length === 0) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" onClick={handleLoad}>
              <FrownIcon />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>No watch providers found</TooltipContent>
        </Tooltip>
      );
    }

    const visibleProviders = data.providers.slice(0, 3);
    return (
      <div className="flex items-center gap-1">
        {visibleProviders.map((provider) => (
          <Tooltip key={provider.providerId}>
            <TooltipTrigger asChild>
              <a
                href={data.link}
                target="_blank"
                rel="noreferrer"
                tabIndex={-1}
                className="flex size-9 items-center justify-center"
              >
                <img
                  src={provider.logoUrl}
                  alt={provider.providerName}
                  className="size-7 rounded border border-border"
                  draggable={false}
                />
              </a>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{provider.providerName}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={handleLoad}>
          <TvIcon />
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>Watch Providers</TooltipContent>
    </Tooltip>
  );
}

export function VoteAverage({ voteAverage, className }: { voteAverage: number; className: string }) {
  const { border, text } = getScoreStyles(voteAverage);
  return (
    <p
      className={cn(
        "flex size-8 select-none items-center justify-center rounded-full border-2 bg-black text-white",
        border,
        className,
      )}
    >
      <span className={cn(text)}>{voteAverage}</span>
    </p>
  );
}

function getScoreStyles(voteAverage: number) {
  if (voteAverage >= 7) {
    return {
      border: "border-green-500",
      text: "text-green-500",
    };
  }

  if (voteAverage >= 5) {
    return {
      border: "border-yellow-500",
      text: "text-yellow-500",
    };
  }

  return {
    border: "border-red-500",
    text: "text-red-500",
  };
}

function ProcessingStatusIndicator({ status }: { status: string }) {
  if (status === "idle") {
    return null;
  }

  if (status === "pending") {
    return <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <AlertCircleIcon className="size-5 text-destructive" />
      </TooltipTrigger>
      <TooltipContent>{status}</TooltipContent>
    </Tooltip>
  );
}
