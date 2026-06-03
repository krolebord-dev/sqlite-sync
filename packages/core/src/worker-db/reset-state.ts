import { createStore, del, get, set } from "idb-keyval";
import { generateId } from "../utils";
import type { WorkerNotificationMessage } from "./worker-common";

export type ResetRequest = {
  epoch: string;
  requestedAt: number;
};

/** Durable async key-value storage for reset state. Injectable for tests. */
export type ResetStore = {
  get: <T>(key: string) => Promise<T | undefined>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

/** Default IndexedDB-backed reset store (idb-keyval over a dedicated database). */
export function createIdbResetStore(): ResetStore {
  const store = createStore("sqlite-sync", "kv");
  return {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    delete: (key) => del(key, store),
  };
}

/**
 * A clean reset is a recovery action for a de-sync detected now. If the reload
 * never happens (broadcast lost, tab crashed mid-reload, browser killed the page),
 * the request must not fire on an arbitrary later cold start and silently wipe
 * local-only writes accumulated since.
 */
export const RESET_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes

const resetRequestKey = (dbId: string) => `sqlite-sync-reset-request-${dbId}`;
const resetAppliedKey = (dbId: string) => `sqlite-sync-reset-applied-${dbId}`;

type ResetStateStoreOptions = {
  store: ResetStore;
  dbId: string;
  now?: () => number;
};

export type ResetStateStore = ReturnType<typeof createResetStateStore>;

/**
 * Worker-owned durable reset state. The reset decision must be owned by the
 * elected worker, not by tabs during `createSyncedDb` — otherwise a later
 * worker election could repeat an already-applied wipe.
 */
export function createResetStateStore({ store, dbId, now = () => Date.now() }: ResetStateStoreOptions) {
  const requestKey = resetRequestKey(dbId);
  const appliedKey = resetAppliedKey(dbId);

  return {
    async writeResetRequest(epoch: string): Promise<ResetRequest> {
      const request: ResetRequest = { epoch, requestedAt: now() };
      await store.set(requestKey, request);
      return request;
    },
    /**
     * Read the pending reset request after winning the worker election.
     * Returns the request only when it has not been applied yet and is within
     * the TTL. Stale requests are deleted so they cannot fire on a later cold start.
     */
    async resolvePendingReset(): Promise<ResetRequest | undefined> {
      const request = await store.get<ResetRequest>(requestKey);
      if (!request) {
        return undefined;
      }

      if (now() - request.requestedAt > RESET_REQUEST_TTL_MS) {
        await store.delete(requestKey);
        return undefined;
      }

      const appliedEpoch = await store.get<string>(appliedKey);
      if (request.epoch === appliedEpoch) {
        return undefined;
      }

      return request;
    },
    /**
     * Record the epoch as applied. Must be called only after the worker has
     * successfully initialized with `clearOnInit: true`, so a failed init can
     * be retried by a later elected worker.
     */
    async markResetApplied(epoch: string): Promise<void> {
      await store.set(appliedKey, epoch);
    },
  };
}

type ReloadRequestHandlerOptions = {
  resetState: ResetStateStore;
  broadcast: (message: Extract<WorkerNotificationMessage, { notificationType: "reload-requested" }>) => void;
  generateEpoch?: () => string;
};

/**
 * Worker-side `requestReload` RPC implementation. For `clean: true` the reset
 * request is durably stored before broadcasting and before the RPC resolves,
 * so the epoch survives no matter which path triggers the reload.
 */
export function createReloadRequestHandler({
  resetState,
  broadcast,
  generateEpoch = generateId,
}: ReloadRequestHandlerOptions) {
  return async (options: { clean: boolean }): Promise<void> => {
    const reloadEpoch = generateEpoch();

    if (options.clean) {
      await resetState.writeResetRequest(reloadEpoch);
    }

    broadcast({
      notificationType: "reload-requested",
      reloadEpoch,
      clean: options.clean,
    });
  };
}
