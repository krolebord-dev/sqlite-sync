export type SyncIdCounter = {
  get current(): number;
  set current(newSyncId: number);
};

export function createSyncIdCounter({
  initialSyncId,
  saveToStorage,
}: {
  initialSyncId: number;
  saveToStorage?: (syncId: number) => void;
}): SyncIdCounter {
  let currentSyncId = initialSyncId;

  return {
    get current() {
      return currentSyncId;
    },
    set current(newSyncId: number) {
      saveToStorage?.(newSyncId);
      currentSyncId = newSyncId;
    },
  };
}

