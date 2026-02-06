import { format } from "date-fns";
import { useSetAtom } from "jotai";
import {
  CalendarIcon,
  Clock4Icon,
  DicesIcon,
  FlameIcon,
  HashIcon,
  RefreshCwIcon,
  SkullIcon,
  ThumbsUpIcon,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatDuration } from "@/lib/utils/format-duration";
import { useDbQuery } from "@/list-db/list-db";
import type { ListItem } from "@/list-db/migrations";
import { VoteAverage } from "./item-card";
import { randomizedItemAtom } from "./list-atoms";

type Priority = "any" | "high" | "normal" | "low";

const MAX_DURATION_OPTIONS = [
  { value: 0, label: "Any" },
  { value: 90, label: "90m" },
  { value: 120, label: "2h" },
  { value: 150, label: "2h 30m" },
  { value: 180, label: "3h" },
  { value: 240, label: "4h" },
] as const;

export function RandomPickerDialog() {
  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button variant="ghost" size="icon" className="size-10 rounded-full">
              <DicesIcon className="size-6! text-gray-400" />
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>What should I watch?</TooltipContent>
      </Tooltip>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>What Should I Watch?</DialogTitle>
          <DialogDescription>Set your constraints and let fate decide</DialogDescription>
        </DialogHeader>
        <RandomPickerContent />
      </DialogContent>
    </Dialog>
  );
}

function RandomPickerContent() {
  const [maxDuration, setMaxDuration] = useState(0);
  const [minRating, setMinRating] = useState(0);
  const [priority, setPriority] = useState<Priority>("any");
  const [selectedTag, setSelectedTag] = useState<string>("any");
  const [pickedItem, setPickedItem] = useState<ListItem | null>(null);

  const setRandomizedItem = useSetAtom(randomizedItemAtom);

  const { data: unwatchedItems } = useDbQuery((db) => {
    return db.selectFrom("item").selectAll().where("watchedAt", "is", null);
  });

  const allTags = useMemo(() => {
    if (!unwatchedItems) return [];
    const tagSet = new Set<string>();
    for (const item of unwatchedItems) {
      try {
        const tags = JSON.parse(item.tags) as string[];
        for (const tag of tags) {
          tagSet.add(tag);
        }
      } catch {
        // skip malformed tags
      }
    }
    return Array.from(tagSet).sort();
  }, [unwatchedItems]);

  const filteredItems = useMemo(() => {
    if (!unwatchedItems) return [];
    return unwatchedItems.filter((item) => {
      if (maxDuration > 0 && item.duration != null && item.duration > maxDuration) return false;
      if (minRating > 0 && (item.rating == null || item.rating < minRating)) return false;
      if (priority === "high" && item.priority !== 1) return false;
      if (priority === "normal" && item.priority !== 0) return false;
      if (priority === "low" && item.priority !== -1) return false;
      if (selectedTag !== "any") {
        try {
          const tags = JSON.parse(item.tags) as string[];
          if (!tags.includes(selectedTag)) return false;
        } catch {
          return false;
        }
      }
      return true;
    });
  }, [unwatchedItems, maxDuration, minRating, priority, selectedTag]);

  const pickRandom = useCallback(() => {
    if (filteredItems.length === 0) return;
    const randomIndex = Math.floor(Math.random() * filteredItems.length);
    setPickedItem(filteredItems[randomIndex]);
  }, [filteredItems]);

  const handleShowInList = useCallback(() => {
    if (pickedItem) {
      setRandomizedItem(pickedItem.id);
    }
  }, [pickedItem, setRandomizedItem]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">Max Duration</Label>
          <div className="flex items-center gap-3">
            <Slider
              min={0}
              max={MAX_DURATION_OPTIONS.length - 1}
              step={1}
              value={[MAX_DURATION_OPTIONS.findIndex((o) => o.value === maxDuration)]}
              onValueChange={([i]) => setMaxDuration(MAX_DURATION_OPTIONS[i].value)}
              className="flex-1"
            />
            <span className="w-16 text-right text-sm tabular-nums">
              {maxDuration === 0 ? "Any" : formatDuration(maxDuration)}
            </span>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-muted-foreground text-xs">Min Rating</Label>
          <div className="flex items-center gap-3">
            <Slider
              min={0}
              max={9}
              step={1}
              value={[minRating]}
              onValueChange={([v]) => setMinRating(v)}
              className="flex-1"
            />
            <span className="w-16 text-right text-sm tabular-nums">{minRating === 0 ? "Any" : `${minRating}+`}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex flex-1 flex-col gap-2">
            <Label className="text-muted-foreground text-xs">Priority</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">
                  <HashIcon className="size-4" /> Any
                </SelectItem>
                <SelectItem value="high">
                  <FlameIcon className="size-4 text-orange-500" /> High
                </SelectItem>
                <SelectItem value="normal">
                  <ThumbsUpIcon className="size-4 text-blue-500" /> Normal
                </SelectItem>
                <SelectItem value="low">
                  <SkullIcon className="size-4 text-gray-500" /> Low
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {allTags.length > 0 && (
            <div className="flex flex-1 flex-col gap-2">
              <Label className="text-muted-foreground text-xs">Tag</Label>
              <Select value={selectedTag} onValueChange={setSelectedTag}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any</SelectItem>
                  {allTags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground text-sm">
          {filteredItems.length} {filteredItems.length === 1 ? "match" : "matches"}
        </span>
        <Button onClick={pickRandom} disabled={filteredItems.length === 0}>
          {pickedItem ? <RefreshCwIcon className="size-4" /> : <DicesIcon className="size-4" />}
          {pickedItem ? "Re-roll" : "Pick for me!"}
        </Button>
      </div>

      {pickedItem && <PickedItemCard item={pickedItem} onShowInList={handleShowInList} />}

      {filteredItems.length === 0 && (
        <p className="py-4 text-center text-muted-foreground text-sm">
          No unwatched items match your filters. Try loosening the constraints.
        </p>
      )}
    </div>
  );
}

function PickedItemCard({ item, onShowInList }: { item: ListItem; onShowInList: () => void }) {
  const tags = useMemo(() => {
    try {
      return JSON.parse(item.tags) as string[];
    } catch {
      return [];
    }
  }, [item.tags]);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-primary bg-card shadow-xs">
      <div className="grid grid-cols-3 items-stretch overflow-hidden rounded-md">
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
          {item.rating != null && item.rating > 0 && (
            <VoteAverage className="absolute top-2 left-2" voteAverage={item.rating} />
          )}
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
              {!!item.duration && (
                <span className="flex items-center gap-1">
                  <Clock4Icon className="size-4!" /> {formatDuration(item.duration)}
                </span>
              )}
              {item.type === "tv" && !!item.episodeCount && (
                <span className="flex items-center gap-1">
                  <HashIcon className="size-4!" /> {item.episodeCount} eps
                </span>
              )}
            </p>
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {tags.slice(0, 4).map((tag) => (
                  <span key={tag} className="rounded-full border border-border bg-card/80 px-2 py-0.5 text-xs">
                    {tag}
                  </span>
                ))}
                {tags.length > 4 && (
                  <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground text-xs">
                    +{tags.length - 4}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end pt-2">
            <Button variant="outline" size="sm" onClick={onShowInList}>
              Show in list
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
