export type StoredValue<T> = {
  get current(): T;
  set current(newValue: T);
};

export function createStoredValue<T>({
  initialValue,
  saveToStorage,
}: {
  initialValue: T;
  saveToStorage?: (value: T) => void;
}): StoredValue<T> {
  let currentValue = initialValue;

  return {
    get current() {
      return currentValue;
    },
    set current(newValue: T) {
      saveToStorage?.(newValue);
      currentValue = newValue;
    },
  };
}
