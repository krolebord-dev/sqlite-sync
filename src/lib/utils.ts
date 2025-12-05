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
