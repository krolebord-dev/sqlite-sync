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
    if (this.onRemove && this.map.has(key)) {
      const old = this.map.get(key) as V;
      this.map.set(key, value);
      this.onRemove(key, old);
    } else {
      this.map.set(key, value);
    }
    if (this.map.size > this.maxSize) {
      const firstKey = this.map.keys().next().value as K;
      this.delete(firstKey);
    }
  };

  get = (key: K): V | undefined => {
    return this.map.get(key);
  };

  delete = (key: K) => {
    if (this.onRemove && this.map.has(key)) {
      const value = this.map.get(key) as V;
      this.map.delete(key);
      this.onRemove(key, value);
    } else {
      this.map.delete(key);
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
