import { useSearch } from "@tanstack/react-router";
import { format } from "date-fns";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { DicesIcon, PartyPopperIcon, RotateCcwIcon, ThumbsDownIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/utils/format-duration";
import { useDbQuery } from "@/list-db/list-db";
import type { ListItem } from "@/list-db/migrations";
import { getPriorityValue, VoteAverage } from "./item-card";
import {
  type RouletteOptions,
  randomizedItemAtom,
  rouletteOptionsAtom,
  rouletteSkippedItemsAtom,
  searchQueryAtom,
  selectedItemsAtom,
} from "./list-atoms";
import { buildReel, pickRandom, type Reel } from "./roulette";

const TILE_WIDTH = 96;
const TILE_GAP = 8;
const TILE_STRIDE = TILE_WIDTH + TILE_GAP;
const SPIN_DURATION_MS = 5500;

type Spin = {
  reel: Reel<string>;
  phase: "spinning" | "result";
};

const typeOptions: { value: RouletteOptions["type"]; label: string }[] = [
  { value: "all", label: "Everything" },
  { value: "movie", label: "Movies" },
  { value: "tv", label: "Series" },
];

const durationOptions: { value: RouletteOptions["maxDuration"]; label: string }[] = [
  { value: null, label: "Any length" },
  { value: 90, label: "≤ 1½h" },
  { value: 120, label: "≤ 2h" },
];

export function RouletteButton() {
  const [open, setOpen] = useState(false);
  const selectedCount = useAtomValue(selectedItemsAtom).length;

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="icon" className="shrink-0" onClick={() => setOpen(true)}>
            <DicesIcon />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>
          {selectedCount > 0 ? `Spin the roulette (${selectedCount} selected)` : "Spin the roulette"}
        </TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <RouletteDialogContent onClose={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function useRoulettePool() {
  const selectedItems = useAtomValue(selectedItemsAtom);
  const searchQuery = useAtomValue(searchQueryAtom);
  const { priority } = useSearch({ from: "/_app/list/$id/" });
  const options = useAtomValue(rouletteOptionsAtom);
  const skippedItems = useAtomValue(rouletteSkippedItemsAtom);

  const { data: candidates } = useDbQuery((db) => {
    let query = db.selectFrom("item").selectAll();

    if (selectedItems.length > 0) {
      query = query.where("id", "in", selectedItems);
    } else {
      query = query.where("watchedAt", "is", null);
      if (priority !== "any") {
        query = query.where("priority", "=", getPriorityValue(priority));
      }
      if (searchQuery) {
        query = query.where("title", "like", `%${searchQuery}%`);
      }
    }

    if (options.type !== "all") {
      query = query.where("type", "=", options.type);
    }
    if (options.maxDuration !== null) {
      query = query.where("duration", "<=", options.maxDuration);
    }

    return query;
  });

  const itemsById = useMemo(() => new Map(candidates.map((item) => [item.id, item])), [candidates]);
  const poolKey = candidates
    .map((item) => item.id)
    .filter((id) => !skippedItems.includes(id))
    .join(",");
  const pool = useMemo(() => (poolKey ? poolKey.split(",") : []), [poolKey]);

  return { pool, itemsById };
}

function RouletteDialogContent({ onClose }: { onClose: () => void }) {
  const { pool, itemsById } = useRoulettePool();
  const [options, setOptions] = useAtom(rouletteOptionsAtom);
  const [skippedItems, setSkippedItems] = useAtom(rouletteSkippedItemsAtom);
  const setRandomizedItem = useSetAtom(randomizedItemAtom);
  const setSelectedItems = useSetAtom(selectedItemsAtom);

  const [spin, setSpin] = useState<Spin | null>(null);
  const idleReel = useMemo(
    () => (pool.length > 0 ? buildReel(pool, pickRandom(pool), pickRandom(pool)) : null),
    [pool],
  );
  const reel = spin?.reel ?? idleReel;
  const restingIndex = spin?.phase === "result" ? spin.reel.winnerIndex : reel?.startIndex;
  const [centerIndex, setCenterIndex] = useState<number | undefined>(restingIndex);
  const winner = spin?.phase === "result" ? itemsById.get(spin.reel.tiles[spin.reel.winnerIndex]) : undefined;

  const stripRef = useRef<HTMLDivElement>(null);
  const spinButtonRef = useRef<HTMLButtonElement>(null);

  const startSpin = useCallback(
    (spinPool: string[]) => {
      if (spinPool.length === 0 || !reel || restingIndex === undefined) {
        setSpin(null);
        return;
      }
      const start = reel.tiles[restingIndex];
      setSpin({ reel: buildReel(spinPool, start, pickRandom(spinPool)), phase: "spinning" });
    },
    [reel, restingIndex],
  );

  useLayoutEffect(() => {
    setCenterIndex(restingIndex);
  }, [restingIndex]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip || spin?.phase !== "spinning") return;

    const { startIndex, winnerIndex } = spin.reel;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const overshoot = (Math.random() - 0.5) * TILE_WIDTH * 0.7;
    const animation = strip.animate(
      [
        { transform: `translateX(${tileOffset(startIndex)}px)`, easing: "cubic-bezier(0.08, 0.7, 0.12, 1)" },
        { transform: `translateX(${tileOffset(winnerIndex) + overshoot}px)`, offset: 0.9, easing: "ease-in-out" },
        { transform: `translateX(${tileOffset(winnerIndex)}px)` },
      ],
      { duration: reducedMotion ? 0 : SPIN_DURATION_MS, fill: "forwards" },
    );

    let lastIndex = startIndex;
    let frame = requestAnimationFrame(function trackCenterTile() {
      const x = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41;
      const index = Math.round((-x - TILE_WIDTH / 2) / TILE_STRIDE);
      if (index !== lastIndex) {
        lastIndex = index;
        setCenterIndex(index);
        navigator.vibrate?.(5);
      }
      frame = requestAnimationFrame(trackCenterTile);
    });

    animation.finished
      .then(() => setSpin((current) => (current?.reel === spin.reel ? { ...current, phase: "result" } : current)))
      .catch(() => {});

    return () => {
      cancelAnimationFrame(frame);
      animation.cancel();
    };
  }, [spin]);

  useEffect(() => {
    if (spin?.phase === "result") navigator.vibrate?.([30, 60, 30]);
  }, [spin?.phase]);

  const isSpinning = spin?.phase === "spinning";

  const updateOptions = (patch: Partial<RouletteOptions>) => {
    setOptions((current) => ({ ...current, ...patch }));
    setSpin(null);
  };

  const skipWinner = () => {
    if (!winner) return;
    setSkippedItems((current) => [...current, winner.id]);
    startSpin(pool.filter((id) => id !== winner.id));
  };

  const acceptWinner = () => {
    if (!winner) return;
    setRandomizedItem(winner.id);
    setSelectedItems([]);
    onClose();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <DialogContent
      className="gap-5 overflow-hidden sm:max-w-2xl"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        spinButtonRef.current?.focus();
      }}
      onInteractOutside={(e) => isSpinning && e.preventDefault()}
    >
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <DicesIcon className="size-5" /> Watch roulette
        </DialogTitle>
        <DialogDescription>Can't decide? Let fate pick what's on tonight.</DialogDescription>
      </DialogHeader>

      <div className="flex flex-wrap gap-2">
        <OptionGroup
          options={typeOptions}
          value={options.type}
          disabled={isSpinning}
          onChange={(type) => updateOptions({ type })}
        />
        <OptionGroup
          options={durationOptions}
          value={options.maxDuration}
          disabled={isSpinning}
          onChange={(maxDuration) => updateOptions({ maxDuration })}
        />
      </div>

      {reel ? (
        <div className="relative -mx-6 h-46 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_20%,black_80%,transparent)]">
          <div className="absolute top-0 left-1/2 z-10 size-0 -translate-x-1/2 border-x-8 border-x-transparent border-t-10 border-t-primary" />
          <div className="absolute bottom-0 left-1/2 z-10 size-0 -translate-x-1/2 border-x-8 border-x-transparent border-b-10 border-b-primary" />
          <div
            ref={stripRef}
            className="absolute top-5 flex"
            style={{
              left: "50%",
              gap: TILE_GAP,
              transform: `translateX(${tileOffset(restingIndex ?? 0)}px)`,
            }}
          >
            {reel.tiles.map((id, index) => (
              <ReelTile
                key={index}
                item={itemsById.get(id)}
                isCentered={index === centerIndex}
                isWinner={!!winner && index === spin?.reel.winnerIndex}
              />
            ))}
          </div>
        </div>
      ) : (
        <EmptyPool
          skippedCount={skippedItems.length}
          onBringBackSkipped={() => setSkippedItems([])}
          onClose={onClose}
        />
      )}

      <p className="sr-only" aria-live="polite">
        {winner ? `Tonight's pick: ${winner.title}` : ""}
      </p>

      {winner ? (
        <WinnerDetails item={winner} />
      ) : (
        reel && (
          <p className="text-center text-muted-foreground text-sm">
            {pool.length === 1
              ? "Only one contender. It was always going to be this one."
              : `${pool.length} titles in the pool`}
            {skippedItems.length > 0 && !isSpinning && (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => setSkippedItems([])}
                >
                  bring back {skippedItems.length} skipped
                </button>
              </>
            )}
          </p>
        )
      )}

      {reel &&
        (winner ? (
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => startSpin(pool)}>
              <RotateCcwIcon /> Spin again
            </Button>
            <Button variant="outline" onClick={skipWinner}>
              <ThumbsDownIcon /> Not tonight
            </Button>
            <Button onClick={acceptWinner}>
              <PartyPopperIcon /> Let's watch it
            </Button>
          </div>
        ) : (
          <Button
            ref={spinButtonRef}
            size="lg"
            className="w-full"
            disabled={isSpinning}
            onClick={() => startSpin(pool)}
          >
            <DicesIcon className={cn(isSpinning && "animate-spin")} />
            {isSpinning ? "Spinning..." : "Spin"}
          </Button>
        ))}
    </DialogContent>
  );
}

function tileOffset(index: number) {
  return -(index * TILE_STRIDE + TILE_WIDTH / 2);
}

function OptionGroup<T extends string | number | null>({
  options,
  value,
  disabled,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex rounded-md border p-0.5">
      {options.map((option) => (
        <Button
          key={option.label}
          size="sm"
          variant={option.value === value ? "secondary" : "ghost"}
          className="h-7"
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function ReelTile({
  item,
  isCentered,
  isWinner,
}: {
  item: ListItem | undefined;
  isCentered: boolean;
  isWinner: boolean;
}) {
  return (
    <div
      className={cn(
        "relative aspect-2/3 shrink-0 overflow-hidden rounded-md border bg-muted transition-transform duration-150",
        isCentered && "scale-105",
        isWinner && "scale-110 border-primary ring-2 ring-primary",
      )}
      style={{ width: TILE_WIDTH }}
    >
      {item?.posterUrl ? (
        <img className="h-full w-full select-none object-cover" draggable={false} src={item.posterUrl} alt="" />
      ) : (
        <span className="flex h-full items-center justify-center p-2 text-center font-medium text-xs">
          {item?.title}
        </span>
      )}
    </div>
  );
}

function WinnerDetails({ item }: { item: ListItem }) {
  const meta = [
    item.type === "tv" ? "Series" : "Movie",
    item.releaseDate ? format(new Date(item.releaseDate), "y") : null,
    item.duration ? formatDuration(item.duration) : null,
    item.type === "tv" && item.episodeCount ? `${item.episodeCount} episodes` : null,
  ].filter(Boolean);

  return (
    <div className="fade-in zoom-in-95 flex animate-in items-start gap-3 duration-300">
      {item.rating && <VoteAverage className="shrink-0" voteAverage={item.rating} />}
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-semibold text-lg leading-tight">{item.title}</p>
        <p className="text-muted-foreground text-sm">{meta.join(" · ")}</p>
        {item.overview && <p className="line-clamp-3 text-muted-foreground text-sm">{item.overview}</p>}
      </div>
    </div>
  );
}

function EmptyPool({
  skippedCount,
  onBringBackSkipped,
  onClose,
}: {
  skippedCount: number;
  onBringBackSkipped: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="font-medium">Nothing left to spin</p>
      <p className="text-muted-foreground text-sm">
        {skippedCount > 0
          ? "You've turned everything down. Feeling picky tonight?"
          : "No unwatched titles match these options."}
      </p>
      {skippedCount > 0 ? (
        <Button variant="outline" onClick={onBringBackSkipped}>
          <RotateCcwIcon /> Bring back {skippedCount} skipped
        </Button>
      ) : (
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      )}
    </div>
  );
}
