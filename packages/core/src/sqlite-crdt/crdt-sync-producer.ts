import type { CrdtStorage } from "./crdt-storage";

type CrdtSyncProducer = {
  storage: CrdtStorage;
  broadcastEvents: (request: { newSyncId: number; eventHlcSum: string | null }) => void;
};

export const createCrdtSyncProducer = ({ storage, broadcastEvents }: CrdtSyncProducer) => {
  storage.addEventListener("events-applied", (event) => {
    broadcastEvents({
      newSyncId: event.payload.syncId,
      eventHlcSum: event.payload.eventHlcSum,
    });
  });
};
