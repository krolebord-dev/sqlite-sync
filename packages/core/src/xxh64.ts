// XXH64 over 32-bit halves kept in locals: on Hermes both BigInt arithmetic and allocating per step are slow.
// Must stay bit-for-bit compatible with xxhash-wasm, since replicas compare checksums across platforms.

const P1_HI = 0x9e3779b1;
const P1_LO = 0x85ebca87;
const P2_HI = 0xc2b2ae3d;
const P2_LO = 0x27d4eb4f;
const P3_HI = 0x165667b1;
const P3_LO = 0x9e3779f9;
const P4_HI = 0x85ebca77;
const P4_LO = 0xc2b2ae63;
const P5_HI = 0x27d4eb2f;
const P5_LO = 0x165667c5;

const TWO_32 = 0x100000000;

// The 64-bit helpers below return their result through these instead of allocating.
let hi = 0;
let lo = 0;

function add(aHi: number, aLo: number, bHi: number, bLo: number) {
  const sum = aLo + bLo;
  hi = (aHi + bHi + (sum >= TWO_32 ? 1 : 0)) >>> 0;
  lo = sum >>> 0;
}

function sub(aHi: number, aLo: number, bHi: number, bLo: number) {
  const difference = aLo - bLo;
  hi = (aHi - bHi - (difference < 0 ? 1 : 0)) >>> 0;
  lo = difference >>> 0;
}

function mul(aHi: number, aLo: number, bHi: number, bLo: number) {
  const a0 = aLo & 0xffff;
  const a1 = aLo >>> 16;
  const b0 = bLo & 0xffff;
  const b1 = bLo >>> 16;

  const mid = a0 * b1 + a1 * b0;
  const low = a0 * b0 + (mid % 0x10000) * 0x10000;
  const carry = Math.floor(low / TWO_32);
  hi = (a1 * b1 + Math.floor(mid / 0x10000) + carry + Math.imul(aHi, bLo) + Math.imul(aLo, bHi)) >>> 0;
  lo = low >>> 0;
}

/** `bits` must be between 1 and 31. */
function rotl(h: number, l: number, bits: number) {
  hi = ((h << bits) | (l >>> (32 - bits))) >>> 0;
  lo = ((l << bits) | (h >>> (32 - bits))) >>> 0;
}

function round(accHi: number, accLo: number, inputHi: number, inputLo: number) {
  mul(inputHi, inputLo, P2_HI, P2_LO);
  add(accHi, accLo, hi, lo);
  rotl(hi, lo, 31);
  mul(hi, lo, P1_HI, P1_LO);
}

function mergeRound(accHi: number, accLo: number, valueHi: number, valueLo: number) {
  round(0, 0, valueHi, valueLo);
  mul((accHi ^ hi) >>> 0, (accLo ^ lo) >>> 0, P1_HI, P1_LO);
  add(hi, lo, P4_HI, P4_LO);
}

function read32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function xxh64(bytes: Uint8Array, seed: bigint): bigint {
  const seedHi = Number((seed >> 32n) & 0xffffffffn);
  const seedLo = Number(seed & 0xffffffffn);
  const length = bytes.length;
  let offset = 0;
  let hashHi: number;
  let hashLo: number;

  if (length >= 32) {
    add(seedHi, seedLo, P1_HI, P1_LO);
    add(hi, lo, P2_HI, P2_LO);
    let v1Hi = hi;
    let v1Lo = lo;
    add(seedHi, seedLo, P2_HI, P2_LO);
    let v2Hi = hi;
    let v2Lo = lo;
    let v3Hi = seedHi;
    let v3Lo = seedLo;
    sub(seedHi, seedLo, P1_HI, P1_LO);
    let v4Hi = hi;
    let v4Lo = lo;

    const limit = length - 32;
    while (offset <= limit) {
      round(v1Hi, v1Lo, read32(bytes, offset + 4), read32(bytes, offset));
      v1Hi = hi;
      v1Lo = lo;
      round(v2Hi, v2Lo, read32(bytes, offset + 12), read32(bytes, offset + 8));
      v2Hi = hi;
      v2Lo = lo;
      round(v3Hi, v3Lo, read32(bytes, offset + 20), read32(bytes, offset + 16));
      v3Hi = hi;
      v3Lo = lo;
      round(v4Hi, v4Lo, read32(bytes, offset + 28), read32(bytes, offset + 24));
      v4Hi = hi;
      v4Lo = lo;
      offset += 32;
    }

    rotl(v1Hi, v1Lo, 1);
    hashHi = hi;
    hashLo = lo;
    rotl(v2Hi, v2Lo, 7);
    add(hashHi, hashLo, hi, lo);
    hashHi = hi;
    hashLo = lo;
    rotl(v3Hi, v3Lo, 12);
    add(hashHi, hashLo, hi, lo);
    hashHi = hi;
    hashLo = lo;
    rotl(v4Hi, v4Lo, 18);
    add(hashHi, hashLo, hi, lo);

    mergeRound(hi, lo, v1Hi, v1Lo);
    mergeRound(hi, lo, v2Hi, v2Lo);
    mergeRound(hi, lo, v3Hi, v3Lo);
    mergeRound(hi, lo, v4Hi, v4Lo);
    hashHi = hi;
    hashLo = lo;
  } else {
    add(seedHi, seedLo, P5_HI, P5_LO);
    hashHi = hi;
    hashLo = lo;
  }

  add(hashHi, hashLo, Math.floor(length / TWO_32), length >>> 0);
  hashHi = hi;
  hashLo = lo;

  while (offset + 8 <= length) {
    round(0, 0, read32(bytes, offset + 4), read32(bytes, offset));
    rotl((hashHi ^ hi) >>> 0, (hashLo ^ lo) >>> 0, 27);
    mul(hi, lo, P1_HI, P1_LO);
    add(hi, lo, P4_HI, P4_LO);
    hashHi = hi;
    hashLo = lo;
    offset += 8;
  }

  if (offset + 4 <= length) {
    mul(0, read32(bytes, offset), P1_HI, P1_LO);
    rotl((hashHi ^ hi) >>> 0, (hashLo ^ lo) >>> 0, 23);
    mul(hi, lo, P2_HI, P2_LO);
    add(hi, lo, P3_HI, P3_LO);
    hashHi = hi;
    hashLo = lo;
    offset += 4;
  }

  while (offset < length) {
    mul(0, bytes[offset], P5_HI, P5_LO);
    rotl((hashHi ^ hi) >>> 0, (hashLo ^ lo) >>> 0, 11);
    mul(hi, lo, P1_HI, P1_LO);
    hashHi = hi;
    hashLo = lo;
    offset++;
  }

  mul(hashHi, (hashLo ^ (hashHi >>> 1)) >>> 0, P2_HI, P2_LO);
  hashHi = hi;
  hashLo = lo;
  mul((hashHi ^ (hashHi >>> 29)) >>> 0, (hashLo ^ ((hashLo >>> 29) | (hashHi << 3))) >>> 0, P3_HI, P3_LO);
  hashHi = hi;
  hashLo = (lo ^ hi) >>> 0;

  return (BigInt(hashHi) << 32n) | BigInt(hashLo);
}

const textEncoder = typeof TextEncoder === "undefined" ? null : new TextEncoder();

export function encodeUtf8(value: string): Uint8Array {
  return textEncoder ? textEncoder.encode(value) : encodeUtf8Fallback(value);
}

/** Matches TextEncoder, including U+FFFD for lone surrogates. */
export function encodeUtf8Fallback(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index++) {
    let codePoint = value.charCodeAt(index);

    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index++;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint < 0x80) {
      bytes.push(codePoint);
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}
