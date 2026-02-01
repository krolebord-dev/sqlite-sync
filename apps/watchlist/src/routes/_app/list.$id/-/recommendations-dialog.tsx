import { generateId } from "@sqlite-sync/core";
import { useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import { CalendarIcon, CheckIcon, Loader2, PlusIcon, RefreshCwIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useDb, useDbQuery } from "@/list-db/list-db";
import { useListOrpc } from "@/list-db/list-orpc-context";
import { VoteAverage } from "./item-card";

type Recommendation = {
  title: string;
  type: "movie" | "tv";
  tmdbId: number;
  posterUrl: string | null;
  overview: string;
  releaseDate: string;
  voteAverage: number;
  reason: string;
};

export function RecommendationsDialog() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="size-10 rounded-full">
          <SparklesIcon className="size-6! text-gray-400" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI Recommendations</DialogTitle>
          <DialogDescription>Personalized suggestions based on your watchlist and reviews</DialogDescription>
        </DialogHeader>
        <RecommendationsContent />
      </DialogContent>
    </Dialog>
  );
}

function RecommendationsContent() {
  const listOrpc = useListOrpc();
  const db = useDb();
  const [customPrompt, setCustomPrompt] = useState("");

  const { data: alreadyAddedTmdbIds } = useDbQuery(
    (db) => db.selectFrom("item").select("tmdbId").where("tmdbId", "is not", null),
    {
      mapData: (data) => new Set(data.map((x) => x.tmdbId)),
    },
  );

  const recommendMutation = useMutation(listOrpc.aiRecommendations.getRecommendations.mutationOptions());

  const handleRecommend = (prompt?: string) => {
    const effectivePrompt = prompt ?? customPrompt.trim();
    if (prompt !== undefined) {
      setCustomPrompt(prompt);
    }
    const excludeTmdbIds = recommendMutation.data?.recommendations.map((r) => r.tmdbId);
    recommendMutation.mutate({
      customPrompt: effectivePrompt || undefined,
      excludeTmdbIds: excludeTmdbIds?.length ? excludeTmdbIds : undefined,
    });
  };

  const handleMoreLikeThis = (title: string) => {
    const prompt = `More like "${title}"`;
    setCustomPrompt(prompt);
    recommendMutation.mutate({ customPrompt: prompt });
  };

  const addItem = (rec: Recommendation) => {
    db.db.executeKysely((db) =>
      db.insertInto("item").values({
        id: generateId(),
        tmdbId: rec.tmdbId,
        type: rec.type,
        title: rec.title,
        posterUrl: rec.posterUrl,
        releaseDate: rec.releaseDate ? new Date(rec.releaseDate).getTime() : null,
        priority: 0,
        overview: rec.overview,
        rating: rec.voteAverage,
        createdAt: Date.now(),
        tags: "[]",
        processingStatus: "idle",
        userRating: null,
        tagHighlights: "{}",
      }),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Textarea
        placeholder="e.g. Something lighthearted for a weekend, or a sci-fi thriller from the 90s..."
        value={customPrompt}
        onChange={(e) => setCustomPrompt(e.target.value)}
        disabled={recommendMutation.isPending}
        className="min-h-10 resize-none"
      />
      <div className="flex items-center justify-between">
        <Button onClick={() => handleRecommend()} disabled={recommendMutation.isPending}>
          {recommendMutation.isPending ? (
            <>
              <Loader2 className="size-4 animate-spin" /> Generating...
            </>
          ) : recommendMutation.data ? (
            <>
              <RefreshCwIcon className="size-4" /> Refresh
            </>
          ) : (
            <>
              <SparklesIcon className="size-4" /> Get Recommendations
            </>
          )}
        </Button>
      </div>

      {recommendMutation.isPending && <RecommendationSkeletons />}

      {recommendMutation.isError && (
        <p className="py-4 text-center text-destructive text-sm">
          Failed to generate recommendations. Please try again.
        </p>
      )}

      {recommendMutation.data?.recommendations.map((rec) => (
        <RecommendationCard
          key={rec.tmdbId}
          recommendation={rec}
          alreadyAdded={alreadyAddedTmdbIds?.has(rec.tmdbId) ?? false}
          onAdd={() => addItem(rec)}
          onMoreLikeThis={() => handleMoreLikeThis(rec.title)}
          isLoading={recommendMutation.isPending}
        />
      ))}

      {recommendMutation.data && recommendMutation.data.recommendations.length > 0 && (
        <SearchRefinements
          refinements={recommendMutation.data.searchRefinements}
          onSelect={(prompt) => handleRecommend(prompt)}
          isLoading={recommendMutation.isPending}
        />
      )}

      {recommendMutation.data?.recommendations.length === 0 && (
        <p className="py-8 text-center text-muted-foreground">
          Add more items to your list to get personalized recommendations.
        </p>
      )}
    </div>
  );
}

type RecommendationCardProps = {
  recommendation: Recommendation;
  alreadyAdded: boolean;
  onAdd: () => void;
  onMoreLikeThis: () => void;
  isLoading: boolean;
};

function RecommendationCard({
  recommendation: rec,
  alreadyAdded,
  onAdd,
  onMoreLikeThis,
  isLoading,
}: RecommendationCardProps) {
  return (
    <div className="group relative grid w-full grid-cols-3 items-stretch overflow-hidden rounded-md border border-border bg-card shadow-xs">
      {rec.posterUrl && (
        <img
          className="pointer-events-none absolute inset-0 h-full w-full object-fill opacity-30 blur-3xl"
          draggable={false}
          src={rec.posterUrl}
          alt={rec.title}
        />
      )}
      <div className="relative aspect-2/3 w-full self-center overflow-hidden">
        {rec.posterUrl && (
          <img
            className="h-full w-full select-none object-cover"
            draggable={false}
            src={rec.posterUrl}
            alt={rec.title}
          />
        )}
        {rec.voteAverage > 0 && <VoteAverage className="absolute top-2 left-2" voteAverage={rec.voteAverage} />}
      </div>
      <div className="col-span-2 flex flex-col justify-between p-4">
        <div className="flex flex-col gap-2">
          <span className="truncate font-semibold">{rec.title}</span>
          <p className="flex flex-wrap gap-x-4 text-muted-foreground text-sm">
            {!!rec.releaseDate && (
              <span className="flex items-center gap-1">
                <CalendarIcon className="size-4!" />
                {format(new Date(rec.releaseDate), "y")}
              </span>
            )}
            <span className="capitalize">{rec.type}</span>
          </p>
          <p className="text-muted-foreground text-sm italic">&ldquo;{rec.reason}&rdquo;</p>
        </div>
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="ghost" size="sm" onClick={onMoreLikeThis} disabled={isLoading}>
            <SearchIcon className="size-4" /> More like this
          </Button>
          <Button variant={alreadyAdded ? "outline" : "default"} size="sm" onClick={onAdd} disabled={alreadyAdded}>
            {alreadyAdded ? (
              <>
                <CheckIcon className="size-4" /> Added
              </>
            ) : (
              <>
                <PlusIcon className="size-4" /> Add to List
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SearchRefinements({
  refinements,
  onSelect,
  isLoading,
}: {
  refinements: Array<{ label: string; prompt: string }>;
  onSelect: (prompt: string) => void;
  isLoading: boolean;
}) {
  if (refinements.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/50 p-4">
      <span className="text-muted-foreground text-sm font-medium">Try a different direction</span>
      <div className="flex flex-wrap gap-2">
        {refinements.map((ref) => (
          <Button key={ref.label} variant="outline" size="sm" onClick={() => onSelect(ref.prompt)} disabled={isLoading}>
            <SparklesIcon className="size-3" />
            {ref.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function RecommendationSkeletons() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
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
