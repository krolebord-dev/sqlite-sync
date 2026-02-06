import { generateId, type SyncedDb } from "@sqlite-sync/core";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  FlameIcon,
  Loader2,
  TrendingUpIcon,
  TvIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { AppHeader, ProjectSelector, UserAvatarDropdown } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { initListDb } from "@/list-db/list-db";
import type { ListDb } from "@/list-db/migrations";
import { type ORPCOutputs, orpc } from "@/orpc/orpc-client";
import { VoteAverage } from "./list.$id/-/item-card";

const dbs = new Map<string, SyncedDb<ListDb>>();

export const Route = createFileRoute("/_app/trending")({
  component: TrendingPage,
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(orpc.list.getLists.queryOptions());
  },
});

type MediaType = "all" | "movie" | "tv";
type TimeWindow = "day" | "week";

function TrendingPage() {
  const [mediaType, setMediaType] = useState<MediaType>("all");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("day");
  const [page, setPage] = useState(1);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [listDb, setListDb] = useState<SyncedDb<ListDb> | null>(null);
  const [isInitializingDb, setIsInitializingDb] = useState(false);

  const { data: lists } = useSuspenseQuery(orpc.list.getLists.queryOptions());

  const handleListSelect = useCallback(async (listId: string) => {
    setSelectedListId(listId);
    let db = dbs.get(listId);
    if (!db) {
      setIsInitializingDb(true);
      db = await initListDb({ listId });
      dbs.set(listId, db);
      setIsInitializingDb(false);
    }
    setListDb(db);
  }, []);

  const handleMediaTypeChange = (value: MediaType) => {
    setMediaType(value);
    setPage(1);
  };

  const handleTimeWindowChange = (value: TimeWindow) => {
    setTimeWindow(value);
    setPage(1);
  };

  return (
    <>
      <AppHeader>
        <div className="flex items-center gap-2">
          <ProjectSelector />
          <Link to="/trending" className="flex items-center gap-1.5 font-semibold text-sm">
            <TrendingUpIcon className="size-4" />
            Trending
          </Link>
        </div>
        <UserAvatarDropdown />
      </AppHeader>

      <div className="flex w-full flex-col items-center">
        <div className="w-full max-w-7xl px-4 pt-4">
          <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <Select value={mediaType} onValueChange={handleMediaTypeChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    <FlameIcon className="size-4" /> All
                  </SelectItem>
                  <SelectItem value="movie">
                    <FilmIcon className="size-4" /> Movies
                  </SelectItem>
                  <SelectItem value="tv">
                    <TvIcon className="size-4" /> TV Shows
                  </SelectItem>
                </SelectContent>
              </Select>

              <Select value={timeWindow} onValueChange={handleTimeWindowChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Today</SelectItem>
                  <SelectItem value="week">This Week</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">Add to:</span>
              <Select value={selectedListId ?? ""} onValueChange={handleListSelect}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Select a list..." />
                </SelectTrigger>
                <SelectContent>
                  {lists.map((list) => (
                    <SelectItem key={list.id} value={list.id}>
                      {list.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isInitializingDb && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            </div>
          </div>

          <TrendingResults
            mediaType={mediaType}
            timeWindow={timeWindow}
            page={page}
            listDb={listDb}
            onPageChange={setPage}
          />
        </div>
      </div>
    </>
  );
}

type TrendingResultsProps = {
  mediaType: MediaType;
  timeWindow: TimeWindow;
  page: number;
  listDb: SyncedDb<ListDb> | null;
  onPageChange: (page: number) => void;
};

function TrendingResults({ mediaType, timeWindow, page, listDb, onPageChange }: TrendingResultsProps) {
  const { data, isLoading } = useQuery(
    orpc.trending.getTrending.queryOptions({
      input: { mediaType, timeWindow, page },
      placeholderData: keepPreviousData,
    }),
  );

  const [addedTmdbIds, setAddedTmdbIds] = useState<Set<number>>(new Set());

  const addItem = useCallback(
    (item: TrendingItem) => {
      if (!listDb) return;
      listDb.db.executeKysely((db) =>
        db.insertInto("item").values({
          id: generateId(),
          tmdbId: item.tmdbId,
          type: item.type,
          title: item.title,
          posterUrl: item.posterUrl,
          releaseDate: item.releaseDate ? new Date(item.releaseDate).getTime() : null,
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
      setAddedTmdbIds((prev) => new Set(prev).add(item.tmdbId));
    },
    [listDb],
  );

  if (isLoading && !data) {
    return <TrendingSkeletons />;
  }

  if (!data || data.results.length === 0) {
    return <p className="py-12 text-center text-muted-foreground">No trending items found.</p>;
  }

  return (
    <>
      <div className="grid gap-4 pb-4 sm:grid-cols-2 xl:grid-cols-3">
        {data.results.map((item) => (
          <TrendingItemCard
            key={item.tmdbId}
            item={item}
            alreadyAdded={addedTmdbIds.has(item.tmdbId)}
            hasListSelected={!!listDb}
            onAdd={() => addItem(item)}
          />
        ))}
      </div>

      <Pagination page={data.page} totalPages={Math.min(data.totalPages, 500)} onPageChange={onPageChange} />
    </>
  );
}

type TrendingItem = ORPCOutputs["trending"]["getTrending"]["results"][number];

type TrendingItemCardProps = {
  item: TrendingItem;
  alreadyAdded: boolean;
  hasListSelected: boolean;
  onAdd: () => void;
};

function TrendingItemCard({ item, alreadyAdded, hasListSelected, onAdd }: TrendingItemCardProps) {
  return (
    <div className="group relative grid w-full grid-cols-3 items-stretch overflow-hidden rounded-md border border-border bg-card shadow-xs">
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
        <span className="absolute top-2 right-2 rounded-full border border-border bg-black/60 px-2 py-0.5 text-[10px] text-white uppercase">
          {item.type}
        </span>
      </div>

      <div className="col-span-2 flex flex-col justify-between p-4">
        <div className="flex flex-col gap-2">
          <span className="truncate font-semibold">{item.title}</span>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm">
            {!!item.releaseDate && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4!" /> {format(new Date(item.releaseDate), "y")}
              </span>
            )}
          </p>
          {item.overview && (
            <p className="line-clamp-2 text-muted-foreground text-xs leading-relaxed">{item.overview}</p>
          )}
        </div>
        <div className="flex items-center justify-end pt-2">
          {hasListSelected ? (
            <Button variant={alreadyAdded ? "outline" : "default"} size="sm" onClick={onAdd} disabled={alreadyAdded}>
              {alreadyAdded ? (
                <>
                  <CheckIcon className="size-4" /> Added
                </>
              ) : (
                <>
                  <TrendingUpIcon className="size-4" /> Add to List
                </>
              )}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs italic">Select a list to add</span>
          )}
        </div>
      </div>
    </div>
  );
}

type PaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-center gap-2 py-6">
      <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        <ChevronLeftIcon className="size-4" />
      </Button>
      <span className="min-w-24 text-center text-muted-foreground text-sm">
        Page {page} of {totalPages}
      </span>
      <Button variant="outline" size="icon" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        <ChevronRightIcon className="size-4" />
      </Button>
    </div>
  );
}

function TrendingSkeletons() {
  return (
    <div className="grid gap-4 pb-8 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="grid grid-cols-3 gap-4 rounded-md border border-border p-4">
          <Skeleton className="aspect-2/3 w-full rounded-md" />
          <div className="col-span-2 flex flex-col gap-3">
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-12 w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
