import { xxhash } from "./hash";

export class BloomFilter {
  private readonly size: number;
  private readonly hashFunctions: number;
  private readonly bitSet: Uint32Array;

  constructor(size: number, hashFunctions: number) {
    this.size = size;
    this.hashFunctions = hashFunctions;
    this.bitSet = new Uint32Array(Math.ceil(size / 32));
  }

  add(value: string): void {
    const hash64 = xxhash.h64(value, 0n);
    const hash1 = Number(hash64 & 0xffffffffn);
    const hash2 = Number((hash64 >> 32n) & 0xffffffffn) | 1;

    for (let i = 0; i < this.hashFunctions; i++) {
      const bitIndex = (hash1 + i * hash2) % this.size;
      this.bitSet[bitIndex >>> 5] |= 1 << (bitIndex & 31);
    }
  }

  has(value: string): boolean {
    const hash64 = xxhash.h64(value, 0n);
    const hash1 = Number(hash64 & 0xffffffffn);
    const hash2 = Number((hash64 >> 32n) & 0xffffffffn) | 1;

    for (let i = 0; i < this.hashFunctions; i++) {
      const bitIndex = (hash1 + i * hash2) % this.size;
      const bitIsSet = this.bitSet[bitIndex >>> 5] & (1 << (bitIndex & 31));
      if (!bitIsSet) return false;
    }
    return true;
  }
}
