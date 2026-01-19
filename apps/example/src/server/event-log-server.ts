import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import type { PersistedCrdtEvent } from "@sqlite-sync/core";
import { type Connection, routePartykitRequest, Server } from "partyserver";
import { migrations } from "../migrations";

type EventLogDbSchema = {
  crdt_events: PersistedCrdtEvent;
};

export class EventLogServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private remoteHandler: RemoteHandler = null!;

  onStart(): void | Promise<void> {
    const { crdtStorage } = durableObjectAdapter.createCrdtStorage<EventLogDbSchema>({
      crdtEventsTable: "crdt_events",
      migrations,
      storage: this.ctx.storage,
    });

    this.remoteHandler = durableObjectAdapter.createRemoteHandler({
      crdtStorage,
      broadcastPayload: (payload) => {
        this.broadcast(payload);
      },
    });
  }

  onMessage(connection: Connection, message: string) {
    const messageResult = this.remoteHandler.handleMessage(message);

    if (!messageResult.success) {
      console.log("Invalid message", messageResult.error);
      return;
    }

    connection.send(messageResult.payload);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ||
      new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
