import type { CrdtStorage, OwnCrdtEvent } from "./crdt-storage";

export type CrdtStorageMutator<Database> = ReturnType<typeof createCrdtStorageMutator<Database>>;

type CommitEventOptions<Database, Table extends keyof Database & string> =
  | {
      type: "item-created";
      dataset: Table;
      item_id: string;
      payload: CreateEventPayload<Database, Table>;
    }
  | {
      type: "item-updated";
      dataset: Table;
      item_id: string;
      payload: UpdateEventPayload<Database, Table>;
    }
  | {
      type: "item-deleted";
      dataset: Table;
      item_id: string;
    };

type CreateEventPayload<Database, Table extends keyof Database> = Omit<Database[Table], "tombstone">;
type UpdateEventPayload<Database, Table extends keyof Database> = Omit<Partial<Database[Table]>, "id" | "tombstone">;

export type SnapshotOptions<Database, Table extends keyof Database & string> = {
  dataset: Table;
  id: string;
  patch: UpdateEventPayload<Database, Table>;
};

export function createCrdtStorageMutator<Database>({ storage }: { storage: CrdtStorage }) {
  const mapToStorageEvent = (event: CommitEventOptions<Database, keyof Database & string>): OwnCrdtEvent => {
    switch (event.type) {
      case "item-created":
        return {
          type: "item-created",
          dataset: event.dataset,
          item_id: event.item_id,
          payload: JSON.stringify(event.payload),
        };
      case "item-updated":
        return {
          type: "item-updated",
          dataset: event.dataset,
          item_id: event.item_id,
          payload: JSON.stringify(event.payload),
        };
      case "item-deleted":
        return {
          type: "item-deleted",
          dataset: event.dataset,
          item_id: event.item_id,
          payload: "{}",
        };
    }
  };

  const enqueueEvents = (events: CommitEventOptions<Database, keyof Database & string>[]) => {
    storage.enqueueOwnEvents(events.map(mapToStorageEvent));
  };

  const createEvent = <Table extends keyof Database & string>(event: CommitEventOptions<Database, Table>) => {
    return event;
  };

  const enqueueEvent = (event: CommitEventOptions<Database, keyof Database & string>) => {
    storage.enqueueOwnEvents([mapToStorageEvent(event)]);
  };

  const enqueueSnapshot = <Table extends keyof Database & string>(snapshot: SnapshotOptions<Database, Table>) => {
    storage.applyOwnSnapshot({
      dataset: snapshot.dataset,
      item_id: snapshot.id,
      patch: { ...snapshot.patch },
    });
  };

  return {
    enqueueEvents,
    createEvent,
    enqueueEvent,
    enqueueSnapshot,
  };
}
