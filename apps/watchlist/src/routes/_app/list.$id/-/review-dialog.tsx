import { useAtom } from "jotai";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { useDb, useDbQuery } from "@/list-db/list-db";
import type { ListItem } from "@/list-db/migrations";
import { reviewItemAtom } from "./list-atoms";

type TagHighlights = Record<string, "positive" | "negative">;

function parseTagHighlights(raw: string): TagHighlights {
  try {
    return JSON.parse(raw) as TagHighlights;
  } catch {
    return {};
  }
}

function cycleTagState(current: "positive" | "negative" | undefined): "positive" | "negative" | undefined {
  if (current === undefined) return "positive";
  if (current === "positive") return "negative";
  return undefined;
}

export function ReviewDialog() {
  const db = useDb();
  const [reviewItemId, setReviewItemId] = useAtom(reviewItemAtom);

  const { data: items } = useDbQuery((db) => db.selectFrom("item").selectAll());

  const item = useMemo(() => {
    if (!reviewItemId) return null;
    return items.find((i) => i.id === reviewItemId) ?? null;
  }, [reviewItemId, items]);

  const handleClose = useCallback(() => {
    setReviewItemId(null);
  }, [setReviewItemId]);

  const handleSubmit = useCallback(
    (userRating: number | null, tagHighlights: string) => {
      if (!item) return;
      db.db.executeKysely((db) => db.updateTable("item").set({ userRating, tagHighlights }).where("id", "=", item.id));
      setReviewItemId(null);
    },
    [db, item, setReviewItemId],
  );

  if (!reviewItemId || !item) return null;

  return (
    <Dialog open={true} onOpenChange={(open) => !open && handleClose()}>
      <ReviewDialogContent item={item} onSubmit={handleSubmit} onClose={handleClose} />
    </Dialog>
  );
}

function ReviewDialogContent({
  item,
  onSubmit,
  onClose,
}: {
  item: ListItem;
  onSubmit: (userRating: number | null, tagHighlights: string) => void;
  onClose: () => void;
}) {
  const tags = useMemo(() => JSON.parse(item.tags) as string[], [item.tags]);
  const existingHighlights = useMemo(() => parseTagHighlights(item.tagHighlights), [item.tagHighlights]);

  const [userRating, setUserRating] = useState<number | null>(item.userRating ?? null);
  const [tagHighlights, setTagHighlights] = useState<TagHighlights>(existingHighlights);

  const handleTagClick = useCallback((tag: string) => {
    setTagHighlights((prev) => {
      const next = { ...prev };
      const newState = cycleTagState(prev[tag]);
      if (newState === undefined) {
        delete next[tag];
      } else {
        next[tag] = newState;
      }
      return next;
    });
  }, []);

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Review — {item.title}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-6 py-2">
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Rating</span>
            <span className="text-muted-foreground text-sm tabular-nums">
              {userRating !== null ? userRating.toFixed(1) : "—"} / 10
            </span>
          </div>
          <Slider
            min={0}
            max={10}
            step={0.5}
            value={userRating !== null ? [userRating] : [5]}
            onValueChange={(values) => setUserRating(values[0])}
          />
        </div>

        {tags.length > 0 && (
          <div className="flex flex-col gap-3">
            <span className="font-medium text-sm">Tag highlights</span>
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const state = tagHighlights[tag];
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => handleTagClick(tag)}
                    className={cn(
                      "cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors",
                      state === "positive" && "border-green-500 bg-green-500/20 text-green-400",
                      state === "negative" && "border-red-500 bg-red-500/20 text-red-400",
                      state === undefined && "border-border bg-card/80 text-foreground hover:bg-accent",
                    )}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => onSubmit(userRating, JSON.stringify(tagHighlights))}>Save Review</Button>
      </DialogFooter>
    </DialogContent>
  );
}
