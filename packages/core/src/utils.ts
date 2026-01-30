export type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export function createDeferredPromise<T>(opts?: { timeout?: number; onTimeout?: () => void }): DeferredPromise<T> {
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
      timeoutId = setTimeout(() => {
        _reject(new Error(`Promise timed out after ${opts.timeout}ms`));
        tryCatch(() => opts?.onTimeout?.());
      }, opts.timeout);
    }
  });

  return { promise, resolve, reject };
}

export const generateId = () => {
  return crypto.randomUUID();
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

  set onmessage(callback: (event: MessageEvent<TMessage>) => void) {
    this.channel.onmessage = callback;
  }
}

export class TypedEvent<T = unknown> extends Event {
  readonly payload: T;
  constructor(type: string, payload: T) {
    super(type);
    this.payload = payload;
  }
}

export type TypedEventTarget<T extends Record<string, unknown>> = {
  addEventListener: <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => void;
  removeEventListener: <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => void;
  dispatchEvent: <K extends keyof T & string>(type: K, payload: T[K]) => void;
};

export const createTypedEventTarget = <T extends Record<string, unknown>>(): TypedEventTarget<T> => {
  const eventTarget = new EventTarget();

  const addEventListener = <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => {
    eventTarget.addEventListener(type, listener as (e: Event) => void);
  };

  const removeEventListener = <K extends keyof T & string>(type: K, listener: (event: TypedEvent<T[K]>) => void) => {
    eventTarget.removeEventListener(type, listener as (e: Event) => void);
  };

  const dispatchEvent = <K extends keyof T & string>(type: K, payload: T[K]) => {
    eventTarget.dispatchEvent(new TypedEvent(type, payload));
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

const safeIdentifierPattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
export function assertSafeIdentifier(identifier: string): string {
  if (!safeIdentifierPattern.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return identifier;
}
