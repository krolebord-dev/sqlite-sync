import MurmurHash3 from "imurmurhash";

export class BloomFilter {
  private readonly size: number;
  private readonly hashFunctions: number;
  private readonly bitSet: Uint32Array;

  constructor(size: number, hashFunctions: number) {
    this.size = size;
    this.hashFunctions = hashFunctions;
    this.bitSet = new Uint32Array(Math.ceil(size / 32));
  }

  private hash(value: string, seed: number) {
    return MurmurHash3(value, seed).result() >>> 0;
  }

  add(value: string): void {
    const hash1 = this.hash(value, 0);
    const hash2 = this.hash(value, 1);

    for (let i = 0; i < this.hashFunctions; i++) {
      const bitIndex = (hash1 + i * hash2) % this.size;
      this.bitSet[bitIndex >>> 5] |= 1 << (bitIndex & 31);
    }
  }

  has(value: string): boolean {
    const hash1 = this.hash(value, 0);
    const hash2 = this.hash(value, 1);

    for (let i = 0; i < this.hashFunctions; i++) {
      const bitIndex = (hash1 + i * hash2) % this.size;
      const bitIsSet = this.bitSet[bitIndex >>> 5] & (1 << (bitIndex & 31));
      if (!bitIsSet) return false;
    }
    return true;
  }
}
