import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import { type Connection, Server } from "partyserver";
import { listOrpcHandler } from "./list-db-router";
import { syncDbSchema } from "./migrations";

export class ListDbServer extends Server<Env> {
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
      mode: "apply-events",
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

  async onRequest(request: Request): Promise<Response> {
    const { matched, response } = await listOrpcHandler.handle(request, {
      prefix: `/list-db/list-db-server/${this.name}/rpc`,
      context: {},
    });

    if (matched) {
      return response;
    }

    return super.onRequest(request);
  }
}
