import type { SQLiteDbWrapper } from "./sqlite-db-wrapper";
import type { PendingCrdtEvent } from "./worker-common";

export function applyCrdtEvent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SQLiteDbWrapper<any>,
  event: PendingCrdtEvent
) {
  db.executeTransaction((db) => {
    const payload = JSON.parse(event.payload);
    switch (event.type) {
      case "item-created": {
        const keys = Array.from(Object.keys(payload));
        db.execute({
          sql: `insert into ${event.dataset} (${keys.join(",")}) values (${keys
            .map(() => "?")
            .join(",")})`,
          parameters: keys.map((key) => payload[key]),
        });
        break;
      }
      case "item-updated": {
        const keys = Array.from(Object.keys(payload));
        db.execute({
          sql: `update ${event.dataset} set ${keys
            .map((key) => `${key} = ?`)
            .join(",")} where id = ?`,
          parameters: [...keys.map((key) => payload[key]), event.item_id],
        });
        break;
      }
      default:
        event.type satisfies never;
    }
  });
}
