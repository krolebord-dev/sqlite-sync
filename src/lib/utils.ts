export function createDeferredPromise<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((_resolve) => {
    resolve = _resolve;
  });
  return { promise, resolve };
}
