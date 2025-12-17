import { createAutoFlushBuffer } from "../utils";
import type { CrdtStorage } from "./crdt-storage";
import type { PersistedCrdtEvent } from "./crdt-table-schema";

type CrdtSyncProducer = {
  bufferSize: number;
  storage: CrdtStorage;
  broadcastEvents: (request: { newSyncId: number }) => void;
};

export const createCrdtSyncProducer = ({ bufferSize, storage, broadcastEvents }: CrdtSyncProducer) => {
  const eventsBuffer = createAutoFlushBuffer<PersistedCrdtEvent>({
    size: bufferSize,
    flush: (events) => {
      if (events.length === 0) {
        return;
      }

      broadcastEvents({ newSyncId: events[events.length - 1].sync_id });
    },
  });

  storage.addEventListener("event-applied", (event) => {
    if (event.payload.status !== "applied") {
      return;
    }
    eventsBuffer.add(event.payload);
  });

  storage.addEventListener("event-processing-done", () => {
    eventsBuffer.flush();
  });
};
