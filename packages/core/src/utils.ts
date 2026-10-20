export type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

type DeferredPromiseOptions = {
  timeout?: number;
  onTimeout?: () => void;
};

export function createDeferredPromise<T>(opts?: DeferredPromiseOptions): DeferredPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = (value) => {
      if (timeoutId) clearTimeout(timeoutId);
      _resolve(value);
    };
    reject = (reason) => {
      if (timeoutId) clearTimeout(timeoutId);
      _reject(reason);
    };

    if (opts?.timeout) {
      timeoutId = setTimeout(rejectTimeout, opts.timeout, _reject, opts);
    }
  });

  return { promise, resolve, reject };
}

function rejectTimeout(reject: (reason?: unknown) => void, opts: DeferredPromiseOptions) {
  reject(new Error(`Promise timed out after ${opts.timeout}ms`));
  tryCatch(() => opts?.onTimeout?.());
}

/**
 * Resolves once the Web Lock is held and keeps holding it until the returned release function is called.
 */
export async function acquireLock(name: string, options: LockOptions) {
  const acquired = createDeferredPromise<void>();
  const released = createDeferredPromise<void>();
  const request = navigator.locks.request(name, options, () => {
    acquired.resolve();
    return released.promise;
  });
  void request.catch((error: unknown) => acquired.reject(error instanceof Error ? error : new Error(String(error))));
  await acquired.promise;

  return async () => {
    released.resolve();
    await request;
  };
}

export const generateId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export type DistributiveOmit<T, K extends keyof T> = T extends any ? Omit<T, K> : never;

export function ensureSingletonExecution<T, TArgs extends any[]>(
  fn: (...args: TArgs) => Promise<T>,
  opts: { queueReExecution?: boolean } = { queueReExecution: true },
) {
  let executingPromise: Promise<T> | null = null;
  let shouldReExecute = false;

  const wrappedFn = (...args: TArgs) => {
    if (executingPromise) {
      shouldReExecute = true;
      return executingPromise;
    }

    executingPromise = fn(...args).finally(() => {
      executingPromise = null;

      if (shouldReExecute && opts?.queueReExecution) {
        shouldReExecute = false;
        wrappedFn(...args);
      }
    });
    return executingPromise;
  };

  wrappedFn.promise = () => executingPromise;
  wrappedFn.isExecuting = () => !!executingPromise;

  return wrappedFn;
}

export function createAutoFlushBuffer<T>({ size, flush }: { size: number; flush: (items: T[]) => void }) {
  const buffer: T[] = [];

  return {
    add(item: T) {
      buffer.push(item);
      if (buffer.length >= size) {
        flush(buffer);
        buffer.length = 0;
      }
    },
    flush() {
      flush(buffer);
      buffer.length = 0;
    },
  };
}

export function createAsyncAutoFlushBuffer<T>({
  size,
  flush,
}: {
  size: number;
  flush: (items: T[]) => void | Promise<void>;
}) {
  const buffer: T[] = [];

  return {
    async add(item: T) {
      buffer.push(item);
      if (buffer.length >= size) {
        await this.flush();
      }
    },
    async flush() {
      const itemsToFlush = buffer.splice(0);
      if (itemsToFlush.length === 0) {
        return;
      }
      await flush(itemsToFlush);
    },
  };
}

export class TypedBroadcastChannel<TMessage> {
  private readonly channel: BroadcastChannel;

  constructor(name: string) {
    this.channel = new BroadcastChannel(name);
  }

  postMessage(message: TMessage) {
    this.channel.postMessage(message);
  }

  set onmessage(callback: ((event: MessageEvent<TMessage>) => void) | null) {
    this.channel.onmessage = callback;
  }

  close() {
    this.channel.close();
  }
}

export class TypedEvent<T = unknown> {
  readonly type: string;
  readonly payload: T;
  constructor(type: string, payload: T) {
    this.type = type;
    this.payload = payload;
  }
}

export type TypedEventTarget<T extends Record<string, unknown>> = {
  addEventListener: <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void,
  ) => { unsubscribe: () => void };
  removeEventListener: <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => void;
  dispatchEvent: <K extends keyof T & string>(type: K, payload: T[K]) => void;
};

/** Follows EventTarget semantics without requiring the global, which React Native lacks. */
export const createTypedEventTarget = <T extends Record<string, unknown>>(): TypedEventTarget<T> => {
  const listeners = new Map<string, Set<(event: TypedEvent<any>) => void>>();

  const removeEventListener = <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => {
    listeners.get(type)?.delete(listener);
  };

  const addEventListener = <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => {
    let typeListeners = listeners.get(type);
    if (!typeListeners) {
      typeListeners = new Set();
      listeners.set(type, typeListeners);
    }
    typeListeners.add(listener);

    return {
      unsubscribe: () => removeEventListener(type, listener),
    };
  };

  const dispatchEvent = <K extends keyof T & string>(type: K, payload: T[K]) => {
    const typeListeners = listeners.get(type);
    if (!typeListeners || typeListeners.size === 0) {
      return;
    }

    const event = new TypedEvent(type, payload);
    for (const listener of Array.from(typeListeners)) {
      if (!typeListeners.has(listener)) {
        continue;
      }
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };

  return {
    addEventListener,
    removeEventListener,
    dispatchEvent,
  };
};

type TryCatchResult<T> =
  | {
      success: true;
      data: T;
    }
  | {
      success: false;
      error: unknown;
    };

export function tryCatch<T>(fn: () => T): TryCatchResult<T> {
  try {
    return {
      success: true,
      data: fn(),
    };
  } catch (error) {
    return {
      success: false,
      error,
    };
  }
}

export async function tryCatchAsync<T>(fn: () => Promise<T>): Promise<TryCatchResult<T>> {
  try {
    return {
      success: true,
      data: await fn(),
    };
  } catch (error) {
    return {
      success: false,
      error,
    };
  }
}

export function jsonSafeParse<T>(json: string) {
  return tryCatch(() => JSON.parse(json) as T);
}

/** Quote a SQLite identifier (table/column name), handling dot-separated schema qualifiers. */
export function quoteId(name: string): string {
  return name
    .split(".")
    .map((s) => `"${s.replace(/"/g, '""')}"`)
    .join(".");
}

export function noop(..._args: unknown[]): void {}

export type ParsedTableName = {
  schema: "main" | (string & {});
  table: string;
  fullIdentifier: string;
};

export function parseTableName(tableName: string): ParsedTableName {
  if (!tableName?.trim()) {
    throw new Error("Parse table: missing table name");
  }
  const parts = tableName.split(".");
  if (parts.length > 2) {
    throw new Error("Parse table: too many dot-delimited segments in table name");
  }

  return parts.length === 1
    ? {
        schema: "main",
        table: parts[0],
        fullIdentifier: parts[0],
      }
    : {
        schema: parts[0],
        table: parts[1],
        fullIdentifier: `${parts[0]}.${parts[1]}`,
      };
}
