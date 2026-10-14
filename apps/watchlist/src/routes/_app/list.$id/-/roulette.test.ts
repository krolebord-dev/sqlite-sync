import { describe, expect, it } from "vitest";
import { buildReel } from "./roulette";

describe("buildReel", () => {
  it("places start and winner tiles at their indexes", () => {
    const reel = buildReel(["a", "b", "c", "d"], "b", "d");

    expect(reel.tiles[reel.startIndex]).toBe("b");
    expect(reel.tiles[reel.winnerIndex]).toBe("d");
    expect(reel.winnerIndex).toBeGreaterThan(reel.startIndex);
    expect(reel.tiles.length).toBeGreaterThan(reel.winnerIndex + 1);
  });

  it("never repeats a tile next to itself when the pool allows it", () => {
    for (let run = 0; run < 50; run++) {
      const { tiles } = buildReel(["a", "b", "c"], "a", "c");
      for (let i = 1; i < tiles.length; i++) {
        expect(tiles[i]).not.toBe(tiles[i - 1]);
      }
    }
  });

  it("fills the reel only from the pool apart from the start tile", () => {
    const pool = ["a", "b", "c"];
    const reel = buildReel(pool, "skipped", "b");

    reel.tiles.forEach((tile, index) => {
      if (index !== reel.startIndex) expect(pool).toContain(tile);
    });
  });

  it("handles a single-item pool", () => {
    const reel = buildReel(["a"], "a", "a");

    expect(reel.tiles.every((tile) => tile === "a")).toBe(true);
  });
});
