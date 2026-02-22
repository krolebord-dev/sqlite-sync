import { generateId } from "@sqlite-sync/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  ArrowLeftIcon,
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  FlameIcon,
  TrendingUpIcon,
  TvIcon,
} from "lucide-react";
import { useCallback, useState } from "react";
import { AppHeader, ProjectSelector, UserAvatarDropdown } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useDb, useDbQuery } from "@/list-db/list-db";
import { type ORPCOutputs, orpc } from "@/orpc/orpc-client";
import { VoteAverage } from "./-/item-card";

export const Route = createFileRoute("/_app/list/$id/trending")({
  component: TrendingPage,
});

type MediaType = "all" | "movie" | "tv";
type TimeWindow = "day" | "week";

function TrendingPage() {
  const [mediaType, setMediaType] = useState<MediaType>("all");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("day");
  const [page, setPage] = useState(1);

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
          <ProjectSelector compact />
          <Button variant="ghost" size="icon" asChild>
            <Link to="/list/$id" params={(prev) => ({ id: prev.id! })}>
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <span className="flex items-center gap-1.5 font-semibold text-sm">
            <TrendingUpIcon className="size-4" />
            Trending
          </span>
        </div>
        <UserAvatarDropdown />
      </AppHeader>

      <div className="flex w-full flex-col items-center">
        <div className="w-full max-w-7xl px-4 pt-4">
          <div className="mb-6 flex items-center gap-2">
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

          <TrendingResults mediaType={mediaType} timeWindow={timeWindow} page={page} onPageChange={setPage} />
        </div>
      </div>
    </>
  );
}

type TrendingResultsProps = {
  mediaType: MediaType;
  timeWindow: TimeWindow;
  page: number;
  onPageChange: (page: number) => void;
};

function TrendingResults({ mediaType, timeWindow, page, onPageChange }: TrendingResultsProps) {
  const db = useDb();

  const { data, isLoading } = useQuery(
    orpc.trending.getTrending.queryOptions({
      input: { mediaType, timeWindow, page },
      placeholderData: keepPreviousData,
    }),
  );

  const { data: existingTmdbIds } = useDbQuery(
    (db) => db.selectFrom("item").select("tmdbId").where("tmdbId", "is not", null),
    { mapData: (data) => new Set(data.map((x) => x.tmdbId)) },
  );

  const [sessionAddedIds, setSessionAddedIds] = useState<Set<number>>(new Set());

  const addItem = useCallback(
    (item: TrendingItem) => {
      db.db.executeKysely((qb) =>
        qb.insertInto("item").values({
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
      setSessionAddedIds((prev) => new Set(prev).add(item.tmdbId));
    },
    [db],
  );

  const removeItem = useCallback(
    (tmdbId: number) => {
      db.db.executeKysely((qb) => qb.deleteFrom("item").where("tmdbId", "=", tmdbId));
      setSessionAddedIds((prev) => {
        const next = new Set(prev);
        next.delete(tmdbId);
        return next;
      });
    },
    [db],
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
        {data.results.map((item) => {
          const alreadyAdded = existingTmdbIds.has(item.tmdbId) || sessionAddedIds.has(item.tmdbId);
          return (
            <TrendingItemCard
              key={item.tmdbId}
              item={item}
              alreadyAdded={alreadyAdded}
              onToggle={() => (alreadyAdded ? removeItem(item.tmdbId) : addItem(item))}
            />
          );
        })}
      </div>

      <TrendingPagination page={data.page} totalPages={Math.min(data.totalPages, 500)} onPageChange={onPageChange} />
    </>
  );
}

type TrendingItem = ORPCOutputs["trending"]["getTrending"]["results"][number];

type TrendingItemCardProps = {
  item: TrendingItem;
  alreadyAdded: boolean;
  onToggle: () => void;
};

function TrendingItemCard({ item, alreadyAdded, onToggle }: TrendingItemCardProps) {
  return (
    <button
      onClick={onToggle}
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
        <span className="absolute bottom-2 right-2 rounded-full border border-border bg-black/60 px-2 py-0.5 text-[10px] text-white uppercase">
          {item.type}
        </span>
      </div>

      <div className="col-span-2 flex flex-col justify-between p-4">
        <div className="flex flex-col gap-2">
          <span className="truncate text-start font-semibold">{item.title}</span>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground text-sm">
            {!!item.releaseDate && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4!" /> {format(new Date(item.releaseDate), "y")}
              </span>
            )}
          </p>
          {item.overview && (
            <p className="line-clamp-2 text-start text-muted-foreground text-xs leading-relaxed">{item.overview}</p>
          )}
        </div>
      </div>
    </button>
  );
}

type TrendingPaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

function TrendingPagination({ page, totalPages, onPageChange }: TrendingPaginationProps) {
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
