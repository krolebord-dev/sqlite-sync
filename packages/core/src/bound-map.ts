interface BoundMapOptions<K, V> {
  maxSize: number;
  onRemove: ((key: K, value: V) => void) | undefined;
}

export class BoundMap<K, V> {
  private map = new Map<K, V>();
  private maxSize: number;
  private onRemove: ((key: K, value: V) => void) | undefined;

  constructor(opts: BoundMapOptions<K, V>) {
    this.maxSize = opts.maxSize;
    this.onRemove = opts.onRemove;
  }

  set = (key: K, value: V) => {
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value as K;
      this.delete(firstKey);
    }
  };

  get = (key: K): V | undefined => {
    return this.map.get(key);
  };

  delete = (key: K) => {
    const value = this.onRemove ? this.map.get(key) : undefined;
    this.map.delete(key);
    if (this.onRemove && value) {
      this.onRemove(key, value);
    }
  };

  clear = () => {
    const onRemove = this.onRemove;
    if (onRemove) {
      this.map.forEach((value, key) => {
        onRemove(key, value);
      });
    }
    this.map.clear();
  };
}
