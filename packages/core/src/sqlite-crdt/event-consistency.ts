import { xxhash } from "../hash";

const MASK_128 = (1n << 128n) - 1n;
const HEX_128_PATTERN = /^[0-9a-f]{32}$/;

export function createEventHlcAccumulator(initialValue: string) {
  let current = parseHex128(initialValue);

  return {
    add(timestamp: string) {
      current = (current + hash128BigInt(timestamp)) & MASK_128;
    },
    get current() {
      return toHex128(current);
    },
  };
}

function parseHex128(value: string) {
  if (value === "") {
    return 0n;
  }
  const normalized = value.toLowerCase();
  if (!HEX_128_PATTERN.test(normalized)) {
    throw new Error(`Invalid event HLC accumulator value: ${value}`);
  }
  return BigInt(`0x${normalized}`);
}

function toHex128(value: bigint) {
  return value.toString(16).padStart(32, "0");
}

function hash128BigInt(value: string) {
  return xxhash.h64(value, 0n) | (xxhash.h64(value, 1n) << 64n);
}
