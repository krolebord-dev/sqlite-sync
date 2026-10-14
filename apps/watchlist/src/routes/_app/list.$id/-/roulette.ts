const LEAD_TILES = 4;
const SPIN_TILES = 48;
const TRAILING_TILES = 6;

export type Reel<T> = {
  tiles: T[];
  startIndex: number;
  winnerIndex: number;
};

export function pickRandom<T>(items: readonly T[], random = Math.random): T {
  return items[Math.floor(random() * items.length)];
}

export function buildReel<T>(pool: readonly T[], start: T, winner: T, random = Math.random): Reel<T> {
  const startIndex = LEAD_TILES;
  const winnerIndex = startIndex + SPIN_TILES;
  const fixed = new Map<number, T>([
    [startIndex, start],
    [winnerIndex, winner],
  ]);

  const tiles: T[] = [];
  for (let i = 0; i <= winnerIndex + TRAILING_TILES; i++) {
    if (fixed.has(i)) {
      tiles.push(fixed.get(i) as T);
      continue;
    }
    const neighbours = [tiles[i - 1], fixed.get(i + 1)];
    const candidates = pool.filter((tile) => !neighbours.includes(tile));
    tiles.push(pickRandom(candidates.length > 0 ? candidates : pool, random));
  }

  return { tiles, startIndex, winnerIndex };
}
