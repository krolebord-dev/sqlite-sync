import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import { type Connection, routePartykitRequest, Server } from "partyserver";
import { syncDbSchema } from "../migrations";

export class EventLogServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private remoteHandler: RemoteHandler = null!;

  onStart(): void | Promise<void> {
    const { crdtStorage } = durableObjectAdapter.createCrdtStorage({
      crdtEventsTable: "crdt_events",
      syncDbSchema,
      storage: this.ctx.storage,
      mode: "store-event-log-only",
    });

    this.remoteHandler = durableObjectAdapter.createRemoteHandler({
      bufferSize: 100,
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
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
