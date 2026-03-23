import { useEffect, useMemo, useRef } from "react";

export type DebouncedCallback<TArgs extends unknown[]> = ((...args: TArgs) => void) & {
  cancel: () => void;
  flush: () => void;
  pending: () => boolean;
};

export function createDebouncedCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay: number,
): DebouncedCallback<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: TArgs | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  const flush = (): void => {
    if (timer === null) return;

    clearTimeout(timer);
    timer = null;

    const args = lastArgs;
    lastArgs = null;

    if (!args) return;

    callback(...args);
  };

  const pending = () => timer !== null;

  const debounced = ((...args: TArgs) => {
    lastArgs = args;

    if (timer !== null) {
      clearTimeout(timer);
    }

    timer = setTimeout(() => {
      timer = null;

      const a = lastArgs;
      lastArgs = null;

      if (!a) return;

      callback(...a);
    }, delay);
  }) as DebouncedCallback<TArgs>;

  debounced.cancel = cancel;
  debounced.flush = flush;
  debounced.pending = pending;

  return debounced;
}

export function useDebounceCallback<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  delay: number,
): DebouncedCallback<TArgs> {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const debounced = useMemo(
    () =>
      createDebouncedCallback<TArgs>((...args) => {
        callbackRef.current(...args);
      }, delay),
    [delay],
  );

  const debouncedRef = useRef(debounced);
  debouncedRef.current = debounced;

  useEffect(() => {
    return () => debounced.cancel();
  }, [debounced]);

  return useMemo(() => {
    const fn = ((...args: TArgs) => {
      debouncedRef.current(...args);
    }) as DebouncedCallback<TArgs>;

    fn.cancel = () => {
      debouncedRef.current.cancel();
    };

    fn.flush = () => {
      debouncedRef.current.flush();
    };

    fn.pending = () => debouncedRef.current.pending();

    return fn;
  }, []);
}
