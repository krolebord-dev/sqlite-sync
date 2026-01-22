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
          type: "item-updated",
          dataset: event.dataset,
          item_id: event.item_id,
          payload: JSON.stringify({ tombstone: 1 }),
        };
    }
  };

  const commitEvents = (events: CommitEventOptions<Database, keyof Database & string>[]) => {
    for (const event of events) {
      commitEvent(event);
    }
  };

  const commitEvent = <Table extends keyof Database & string>(opts: CommitEventOptions<Database, Table>) => {
    storage.applyOwnEvent(mapToStorageEvent(opts));
  };

  return {
    commitEvents,
    commitEvent,
  };
}
