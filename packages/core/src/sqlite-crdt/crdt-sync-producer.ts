import type { CrdtStorage } from "./crdt-storage";

type CrdtSyncProducer = {
  storage: CrdtStorage;
  broadcastEvents: (request: { newSyncId: number; stateHash: string | null }) => void;
};

export const createCrdtSyncProducer = ({ storage, broadcastEvents }: CrdtSyncProducer) => {
  storage.addEventListener("events-applied", (event) => {
    broadcastEvents({
      newSyncId: event.payload.syncId,
      stateHash: event.payload.stateHash,
    });
  });
};
