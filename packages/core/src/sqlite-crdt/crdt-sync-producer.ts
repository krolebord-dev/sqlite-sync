import type { CrdtStorage } from "./crdt-storage";

type CrdtSyncProducer = {
  bufferSize: number;
  storage: CrdtStorage;
  broadcastEvents: (request: { newSyncId: number }) => void;
};

export const createCrdtSyncProducer = ({ storage, broadcastEvents }: CrdtSyncProducer) => {
  storage.addEventListener("events-applied", (event) => {
    broadcastEvents({ newSyncId: event.payload.syncId });
  });
};
