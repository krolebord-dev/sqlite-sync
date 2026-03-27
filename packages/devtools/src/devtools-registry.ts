import type { SyncedDb } from "@sqlite-sync/core";

const devtoolsRegistrySymbol = Symbol.for("@sqlite-sync/devtools");

export type SQLiteSyncDevtoolsInstance = {
  instanceId: string;
  dbId: string;
  createdAt: number;
  instance: SyncedDb<any>;
};

export type SQLiteSyncDevtoolsSnapshot = {
  instances: readonly SQLiteSyncDevtoolsInstance[];
};

export type SQLiteSyncDevtoolsRegistry = {
  version: 1;
  instances: Map<string, SQLiteSyncDevtoolsInstance>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SQLiteSyncDevtoolsSnapshot;
  register(instance: SQLiteSyncDevtoolsInstance): () => void;
};

type RegistryGlobal = typeof globalThis & {
  [key: symbol]: SQLiteSyncDevtoolsRegistry | undefined;
};

function createSQLiteSyncDevtoolsRegistry(): SQLiteSyncDevtoolsRegistry {
  const instances = new Map<string, SQLiteSyncDevtoolsInstance>();
  const listeners = new Set<() => void>();
  let snapshot: SQLiteSyncDevtoolsSnapshot = {
    instances: [],
  };

  const notify = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const updateSnapshot = () => {
    snapshot = {
      instances: Array.from(instances.values()),
    };
    notify();
  };

  return {
    version: 1,
    instances,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return snapshot;
    },
    register(instance) {
      instances.set(instance.instanceId, instance);
      updateSnapshot();

      let isUnregistered = false;
      return () => {
        if (isUnregistered) return;
        isUnregistered = true;

        if (!instances.delete(instance.instanceId)) return;
        updateSnapshot();
      };
    },
  };
}

export function getOrCreateSQLiteSyncDevtoolsRegistry(): SQLiteSyncDevtoolsRegistry {
  const registryGlobal = globalThis as RegistryGlobal;

  registryGlobal[devtoolsRegistrySymbol] ??= createSQLiteSyncDevtoolsRegistry();

  return registryGlobal[devtoolsRegistrySymbol];
}
