import initXxhash, { type XXHashAPI } from "xxhash-wasm";
import { encodeUtf8, xxh64 } from "./xxh64";

type Hasher = {
  h64: (input: string, seed: bigint) => bigint;
  h64Concat: (input: string) => bigint;
};

let loadPromise: Promise<void> | null = null;
let hasher: Hasher | null = null;

const jsHasher: Hasher = {
  h64: (input, seed) => xxh64(encodeUtf8(input), seed),
  h64Concat: (input) => {
    const bytes = encodeUtf8(input);
    return xxh64(bytes, 0n) | (xxh64(bytes, 1n) << 64n);
  },
};

// xxhash-wasm writes strings straight into wasm memory, which is cheaper than encoding them once up front.
function createWasmHasher(api: XXHashAPI): Hasher {
  return {
    h64: (input, seed) => api.h64(input, seed),
    h64Concat: (input) => api.h64(input, 0n) | (api.h64(input, 1n) << 64n),
  };
}

function ensureLoaded(): Promise<void> {
  if (!loadPromise) {
    if (typeof WebAssembly === "undefined") {
      hasher = jsHasher;
      loadPromise = Promise.resolve();
    } else {
      // Instantiation can still fail, e.g. under a CSP without 'wasm-unsafe-eval'; the JS hasher gives the same hashes.
      loadPromise = initXxhash().then(
        (api) => {
          hasher = createWasmHasher(api);
        },
        () => {
          hasher = jsHasher;
        },
      );
    }
  }
  return loadPromise;
}

function getHasher() {
  if (!hasher) {
    throw new Error("xxhash is not initialized; call xxhash.ensureLoaded() first");
  }
  return hasher;
}

function h64(input: string, seed = 0n): bigint {
  return getHasher().h64(input, seed);
}

/** `h64(input, 0n) | (h64(input, 1n) << 64n)`, encoding `input` only once where that is cheaper. */
function h64Concat(input: string): bigint {
  return getHasher().h64Concat(input);
}

export const xxhash = {
  ensureLoaded,
  h64,
  h64Concat,
};
