import initXxhash, { type XXHashAPI } from "xxhash-wasm";

let loadPromise: Promise<void> | null = null;
let api: XXHashAPI | null = null;

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = initXxhash().then((hasher) => {
      api = hasher;
    });
  }
  return loadPromise;
}

function h64(input: string, seed = 0n): bigint {
  if (!api) {
    throw new Error("xxhash is not initialized; call xxhash.ensureLoaded() first");
  }
  return api.h64(input, seed);
}

export const xxhash = {
  ensureLoaded,
  h64,
};
