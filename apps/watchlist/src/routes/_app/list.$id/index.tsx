import { generateId } from "@sqlite-sync/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { format } from "date-fns";
import { Provider, useAtom, useAtomValue, useSetAtom } from "jotai";
import { useHydrateAtoms } from "jotai/utils";
import { sql } from "kysely";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CalendarIcon,
  CheckIcon,
  Clock4Icon,
  EllipsisVertical,
  EyeIcon,
  EyeOffIcon,
  HashIcon,
  Loader2,
  SettingsIcon,
  ShuffleIcon,
  SquareDashed,
  SquareDashedMousePointerIcon,
  StarIcon,
  TrendingUpIcon,
  Wifi,
  WifiOff,
  XIcon,
} from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppHeader, ProjectSelector, UserAvatarDropdown } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useThrottle } from "@/lib/utils/use-throttle";
import { useDb, useDbQuery, useDbState } from "@/list-db/list-db";
import type { ListItem } from "@/list-db/migrations";
import { type ORPCOutputs, orpc } from "@/orpc/orpc-client";
import { priorityColors } from "./-/common";
import { getPriorityValue, ListItemCard, VoteAverage } from "./-/item-card";
import {
  clearRandomizedItemAtom,
  clearSelectedItemsAtom,
  dbAtom,
  isSelectionModeAtom,
  itemsFilterSchema,
  randomizedItemAtom,
  type SortingOptions,
  searchQueryAtom,
  selectAllAtom,
  selectRandomFromSelectedItemsAtom,
} from "./-/list-atoms";
import { ListSettingsSheet } from "./-/list-settings";
import { RecommendationsDialog } from "./-/recommendations-dialog";
import { ReviewDialog } from "./-/review-dialog";

export const Route = createFileRoute("/_app/list/$id/")({
  component: RouteComponent,
  validateSearch: itemsFilterSchema,
});

function RouteComponent() {
  return (
    <Provider>
      <HydrateListAtoms>
        <ListPage />
      </HydrateListAtoms>
    </Provider>
  );
}

function HydrateListAtoms({ children }: { children: React.ReactNode }) {
  const db = useDb();
  useHydrateAtoms([[dbAtom, db]] as any);
  return children;
}

function ListPage() {
  return (
    <>
      <AppHeader>
        <div className="flex min-w-0 items-center gap-1 sm:gap-2">
          <ProjectSelector compact />
          <RecommendationsDialog />
          <TrendingLink />
          <ListSettings />
        </div>
        <div className="flex items-center gap-1 sm:gap-2">
          <OnlineStatusIndicator />
          <UserAvatarDropdown />
        </div>
      </AppHeader>
      <div className="sticky top-0 z-10 flex items-center justify-center bg-background/80 pb-2 backdrop-blur-md">
        <div className="grid w-full max-w-7xl grid-cols-[1fr_auto] items-center justify-start gap-x-4 gap-y-1 px-4 pt-2 sm:grid-cols-[auto_1fr_auto]">
          <SortingHeader />
          <SearchInput className="max-sm:col-span-2 max-sm:row-start-2 sm:max-w-52" />
          <HeaderMenu />
        </div>
      </div>
      <div className="flex w-full flex-col items-center">
        <ItemsList />
        <TmdbSearchResults />
      </div>
      <ReviewDialog />
    </>
  );
}

function HeaderMenu({ className }: { className?: string }) {
  const isSelectionMode = useAtomValue(isSelectionModeAtom);
  const isRandomizedItem = !!useAtomValue(randomizedItemAtom);

  const clearSelectedItems = useSetAtom(clearSelectedItemsAtom);
  const selectAllItems = useSetAtom(selectAllAtom);
  const selectRandomFromSelectedItems = useSetAtom(selectRandomFromSelectedItemsAtom);
  const clearRandomizedItem = useSetAtom(clearRandomizedItemAtom);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild className={cn("shrink-0", className)}>
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
              selectAllItems();
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

const onlineStatusConfig = {
  online: {
    label: "Online",
    icon: <Wifi className="size-4" />,
    className: "text-emerald-500",
  },
  pending: {
    label: "Connecting",
    icon: <Loader2 className="size-4 animate-spin" />,
    className: "text-amber-500",
  },
  offline: {
    label: "Offline",
    icon: <WifiOff className="size-4" />,
    className: "text-rose-500",
  },
} as const;

function OnlineStatusIndicator() {
  const { workerDb } = useDb();
  const { remoteState } = useDbState();
  const status = onlineStatusConfig[remoteState ?? "offline"];

  const toggleOnlineStatus = () => {
    if (remoteState === "online") {
      workerDb.goOffline();
    } else {
      workerDb.goOnline();
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn("h-9 w-9", status.className)}
          aria-label={`Sync status: ${status.label}`}
          onClick={toggleOnlineStatus}
        >
          {status.icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{status.label}</TooltipContent>
    </Tooltip>
  );
}

function SortingHeader({ className }: { className?: string }) {
  const { sortBy, sortOrder } = useSearch({ from: "/_app/list/$id/" });

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            {sortByIcon[sortBy]}
            <span className="max-sm:hidden">{sortByLabel[sortBy]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <SortingOption sortBy="duration" />
          <SortingOption sortBy="createdAt" />
          <SortingOption sortBy="rating" />
          <SortingOption sortBy="priority" />
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="icon" asChild>
        <Link to="." search={(prev) => ({ ...prev, sortOrder: sortOrder === "asc" ? "desc" : "asc" })}>
          {sortOrderIcon[sortOrder]}
        </Link>
      </Button>
      <WatchedFilterToggle />
      <FilterButton />
    </div>
  );
}

const watchedNextState: Record<SortingOptions["watched"], SortingOptions["watched"]> = {
  all: "unwatched",
  unwatched: "watched",
  watched: "all",
};

const watchedConfig: Record<SortingOptions["watched"], { icon: React.ReactNode; label: string; className?: string }> = {
  all: { icon: <EyeIcon />, label: "All" },
  unwatched: { icon: <EyeOffIcon />, label: "Not watched", className: "text-muted-foreground" },
  watched: { icon: <EyeIcon />, label: "Watched", className: "text-emerald-500" },
};

function WatchedFilterToggle() {
  const { watched } = useSearch({ from: "/_app/list/$id/" });
  const config = watchedConfig[watched];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" className={config.className} asChild>
          <Link to="." search={(prev) => ({ ...prev, watched: watchedNextState[watched] })}>
            {config.icon}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{config.label}</TooltipContent>
    </Tooltip>
  );
}

const sortOrderIcon: Record<SortingOptions["sortOrder"], React.ReactNode> = {
  asc: <ArrowUpIcon />,
  desc: <ArrowDownIcon />,
};

const sortByIcon: Record<SortingOptions["sortBy"], React.ReactNode> = {
  duration: <Clock4Icon />,
  rating: <StarIcon />,
  createdAt: <CalendarIcon />,
  priority: <HashIcon />,
};

const sortByLabel: Record<SortingOptions["sortBy"], string> = {
  duration: "Duration",
  rating: "Rating",
  createdAt: "Date Added",
  priority: "Priority",
};

type SortingByOptionProps = {
  sortBy: SortingOptions["sortBy"];
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

function FilterButton() {
  const { priority } = useSearch({ from: "/_app/list/$id/" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className={priority === "any" ? undefined : priorityColors[priority].text}
        >
          {priority === "any" ? <HashIcon /> : priorityColors[priority].icon}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: "high" })} className={priorityColors.high.text}>
            {priorityColors.high.icon}
            High
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: "normal" })} className={priorityColors.normal.text}>
            {priorityColors.normal.icon}
            Normal
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: "low" })} className={priorityColors.low.text}>
            {priorityColors.low.icon}
            Low
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="." search={(prev) => ({ ...prev, priority: "any" })}>
            <HashIcon /> Any
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SearchInput({ className }: { className?: string }) {
  const [searchQuery, setSearchQuery] = useAtom(searchQueryAtom);

  return (
    <div className={cn("relative", className)}>
      <Input
        placeholder="Search..."
        className="pr-9"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
      {searchQuery.length > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="absolute top-1/2 right-1 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear search"
          onClick={() => setSearchQuery("")}
        >
          <XIcon className="size-4" />
        </Button>
      )}
    </div>
  );
}

function useOrderedAndFilteredItems() {
  const { sortBy, sortOrder, priority, watched } = useSearch({ from: "/_app/list/$id/" });
  const searchQuery = useAtomValue(searchQueryAtom);
  const randomizedItem = useAtomValue(randomizedItemAtom);

  const { data: items } = useDbQuery((db) => {
    let query = db
      .selectFrom("item")
      .selectAll()
      .orderBy(sql`(id = ${randomizedItem}) desc`)
      .orderBy("watchedAt", (ob) => ob.nullsFirst().desc())
      .orderBy(sortBy, sortOrder);
    if (priority !== "any") {
      query = query.where("priority", "=", getPriorityValue(priority));
    }

    if (watched === "watched") {
      query = query.where("watchedAt", "is not", null);
    } else if (watched === "unwatched") {
      query = query.where("watchedAt", "is", null);
    }

    if (searchQuery) {
      query = query.where("title", "like", `%${searchQuery}%`);
    }

    return query;
  });

  return items;
}

function ItemsList() {
  const orderedAndFilteredItems = useOrderedAndFilteredItems() ?? [];

  if (orderedAndFilteredItems.length <= 100) {
    return (
      <div className="flex w-full max-w-7xl flex-wrap justify-center gap-4 px-4 pt-2 pb-20 md:grid md:grid-cols-2 xl:grid-cols-3">
        {orderedAndFilteredItems.map((item) => (
          <ListItemCard key={item.id} item={item} />
        ))}
      </div>
    );
  }

  return <VirtualizedItemsList items={orderedAndFilteredItems} />;
}

function VirtualizedItemsList({ items }: { items: ListItem[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const containerWidth = useElementWidth(containerRef);
  const containerTop = useElementDocumentTop(containerRef);

  const columnCount = useMemo(() => {
    if (containerWidth >= 1280) return 3;
    if (containerWidth >= 768) return 2;
    return 1;
  }, [containerWidth]);

  const estimateSize = useCallback(() => 260, []);
  const measureElement = useCallback((el: HTMLElement) => el.getBoundingClientRect().height, []);
  const getItemKey = useCallback((index: number) => items[index]?.id ?? index, [items]);

  const gapPx = 16;
  const paddingX = 16;
  const laneWidth = useMemo(() => {
    const availableWidth = containerWidth - paddingX * 2;
    if (columnCount <= 1) return availableWidth;
    const totalGap = gapPx * (columnCount - 1);
    return Math.max(0, (availableWidth - totalGap) / columnCount);
  }, [columnCount, containerWidth]);
  const rowVirtualizer = useWindowVirtualizer({
    count: items.length,
    estimateSize,
    overscan: columnCount,
    scrollMargin: containerTop,
    measureElement,
    getItemKey,
    gap: gapPx,
    lanes: columnCount,
  });

  const virtualItems = rowVirtualizer.getVirtualItems();
  const scrollMargin = rowVirtualizer.options.scrollMargin ?? 0;

  return (
    <div ref={containerRef} className="w-full max-w-7xl pt-2 pb-20">
      <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          if (!item) return null;
          const laneOffset = paddingX + virtualItem.lane * (laneWidth + gapPx);

          return (
            <div
              key={virtualItem.key}
              ref={rowVirtualizer.measureElement}
              data-index={virtualItem.index}
              className="absolute top-0 left-0"
              style={{
                width: laneWidth,
                transform: `translate3d(${laneOffset}px, ${virtualItem.start - scrollMargin}px, 0)`,
              }}
            >
              <ListItemCard item={item} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => setWidth(el.getBoundingClientRect().width);
    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return width;
}

function useElementDocumentTop(ref: React.RefObject<HTMLElement | null>) {
  const [top, setTop] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;

    const update = () => setTop(el.getBoundingClientRect().top + window.scrollY);
    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return top;
}

type SearchResultItem = ORPCOutputs["search"]["search"][number];

function TmdbSearchResults() {
  const db = useDb();
  const searchQuery = useAtomValue(searchQueryAtom);
  const throttledQuery = useThrottle(searchQuery, 300);

  const { data: alreadyAddedTmdbIds } = useDbQuery(
    (db) => db.selectFrom("item").select("tmdbId").where("tmdbId", "is not", null),
    {
      mapData: (data) => new Set(data.map((x) => x.tmdbId)),
    },
  );

  const { data: searchResults, isLoading } = useQuery(
    orpc.search.search.queryOptions({
      input: { q: throttledQuery },
      enabled: !!throttledQuery,
      placeholderData: keepPreviousData,
    }),
  );

  const addItem = (item: SearchResultItem) => {
    db.db.executeKysely((db) =>
      db.insertInto("item").values({
        id: generateId(),
        tmdbId: item.tmdbId,
        type: item.type,
        title: item.title,
        posterUrl: item.posterUrl,
        releaseDate: new Date(item.releaseDate).getTime(),
        priority: 0,
        overview: item.overview,
        rating: item.voteAverage,
        createdAt: Date.now(),
        tags: "[]",
        processingStatus: "idle",
        userRating: null,
        tagHighlights: "{}",
      }),
    );
  };

  const removeItem = (tmdbId: number) => {
    db.db.executeKysely((db) => db.deleteFrom("item").where("tmdbId", "=", tmdbId));
  };

  if (!throttledQuery) {
    return null;
  }

  if (!searchResults || (searchResults.length === 0 && !isLoading)) {
    return null;
  }

  return (
    <div className="flex w-full flex-col items-center border-border border-t bg-muted/30 pt-4">
      <div className="w-full max-w-7xl px-4">
        <h2 className="mb-4 font-medium text-muted-foreground text-sm">Add from TMDB</h2>
        <div className="flex w-full flex-wrap justify-center gap-4 pb-8 md:grid md:grid-cols-2 xl:grid-cols-3">
          {searchResults.map((item) => {
            const alreadyAdded = alreadyAddedTmdbIds.has(item.tmdbId);
            return (
              <TmdbSearchResultCard
                alreadyAdded={alreadyAddedTmdbIds.has(item.tmdbId)}
                key={item.tmdbId}
                item={item}
                onClick={() => (alreadyAdded ? removeItem(item.tmdbId) : addItem(item))}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

type TmdbSearchResultCardProps = {
  item: SearchResultItem;
  alreadyAdded: boolean;
  onClick: () => void;
};

function TmdbSearchResultCard({ item, alreadyAdded, onClick }: TmdbSearchResultCardProps) {
  return (
    <button
      onClick={onClick}
      type="button"
      className="group relative grid w-full cursor-pointer grid-cols-3 items-stretch overflow-hidden rounded-md border border-border border-dashed bg-card shadow-xs"
    >
      {item.posterUrl && (
        <img
          className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-30 blur-3xl"
          draggable={false}
          src={item.posterUrl}
          alt={item.title}
        />
      )}
      <div className="relative aspect-2/3 w-full self-center overflow-hidden">
        {item.posterUrl && (
          <img
            className="h-full w-full select-none object-cover"
            draggable={false}
            src={item.posterUrl}
            alt={item.title}
          />
        )}
        {item.voteAverage > 0 && <VoteAverage className="absolute top-2 left-2" voteAverage={item.voteAverage} />}
        {alreadyAdded && (
          <p className="absolute top-2 right-2 flex size-8 select-none items-center justify-center rounded-full bg-primary text-white">
            <CheckIcon />
          </p>
        )}
      </div>

      <div className="col-span-2 flex flex-col justify-between p-4">
        <div className="flex flex-col gap-2">
          <span className="truncate text-start font-semibold">{item.title}</span>
          <p className="flex flex-wrap gap-x-4 gap-y-2 text-muted-foreground text-sm">
            {!!item.releaseDate && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4!" /> {format(new Date(item.releaseDate), "y")}
              </span>
            )}
          </p>
        </div>
      </div>
    </button>
  );
}

function TrendingLink() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8 rounded-full sm:size-10" asChild>
          <Link to="/list/$id/trending" params={(prev) => ({ id: prev.id! })}>
            <TrendingUpIcon className="size-4 text-gray-400 sm:size-6" />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>Trending</TooltipContent>
    </Tooltip>
  );
}

function ListSettings() {
  return (
    <ListSettingsSheet asChild>
      <Button variant="ghost" size="icon" className="size-8 rounded-full sm:size-10">
        <SettingsIcon className="size-4 text-gray-400 sm:size-6" />
      </Button>
    </ListSettingsSheet>
  );
}
