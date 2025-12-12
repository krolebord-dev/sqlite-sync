export type DeferredPromise<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

export function createDeferredPromise<T>(): DeferredPromise<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

export const generateId = () => {
  return crypto.randomUUID();
};

export type DistributiveOmit<T, K extends keyof T> = T extends any
  ? Omit<T, K>
  : never;

export function ensureSingletonExecution(fn: () => Promise<void>) {
  let isExecuting = false;
  let shouldReExecute = false;

  const wrappedFn = () => {
    if (isExecuting) {
      shouldReExecute = true;
      return;
    }

    isExecuting = true;
    fn().finally(() => {
      isExecuting = false;

      if (shouldReExecute) {
        shouldReExecute = false;
        wrappedFn();
      }
    });
  };

  wrappedFn.isExecuting = () => isExecuting;

  return wrappedFn;
}

export function orderBy<T>(
  inputArray: T[],
  picker: (item: T) => any,
  opts?: {
    direction?: "asc" | "desc";
    inPlace?: boolean;
  }
): T[] {
  const array = opts?.inPlace ? inputArray : [...inputArray];
  const direction = opts?.direction ?? "asc";
  return array.sort((a, b) => {
    const aVal = picker(a);
    const bVal = picker(b);

    if (aVal < bVal) return direction === "asc" ? -1 : 1;
    if (aVal > bVal) return direction === "asc" ? 1 : -1;
    return 0;
  });
}

export function createAutoFlushBuffer<T>({
  size,
  flush,
}: {
  size: number;
  flush: (items: T[]) => void;
}) {
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

export const createTypedEventTarget = <T extends Record<string, unknown>>() => {
  const eventTarget = new EventTarget();

  const addEventListener = <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void
  ) => {
    eventTarget.addEventListener(type, listener as (e: Event) => void);
  };

  const removeEventListener = <K extends keyof T & string>(
    type: K,
    listener: (event: TypedEvent<T[K]>) => void
  ) => {
    eventTarget.removeEventListener(type, listener as (e: Event) => void);
  };

  const dispatchEvent = <K extends keyof T & string>(
    type: K,
    payload: T[K]
  ) => {
    eventTarget.dispatchEvent(new TypedEvent(type, payload));
  };

  return {
    addEventListener,
    removeEventListener,
    dispatchEvent,
  };
};

export function jsonSafeParse<T>(json: string):
  | {
      status: "ok";
      data: T;
    }
  | {
      status: "error";
      error: unknown;
    } {
  try {
    return {
      status: "ok",
      data: JSON.parse(json),
    };
  } catch (error) {
    return {
      status: "error",
      error,
    };
  }
}
