import { describe, expect, it, vi } from "vitest";
import type { SyncServerMessage, SyncServerRequest } from "../src/server";
import { createWsRemoteSource } from "../src/web-socket/ws-remote-source";

class FakeSocket extends EventTarget {
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: SyncServerRequest[] = [];
  readyState: number = WebSocket.CONNECTING;
  close = vi.fn();

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  drop() {
    this.readyState = WebSocket.CLOSED;
  }

  receive(message: SyncServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connect = async () => {
  const socket = new FakeSocket();
  const onReconnected = vi.fn();
  const controller = new AbortController();
  const connecting = createWsRemoteSource({ createWebSocket: () => socket as never })({
    onEventsAvailable: vi.fn(),
    onReconnected,
    signal: controller.signal,
  });
  socket.open();
  const source = await connecting;
  return { socket, source, onReconnected, controller };
};

describe("createWsRemoteSource", () => {
  it("reports every open after the first one as a reconnect", async () => {
    const { socket, onReconnected } = await connect();
    expect(onReconnected).not.toHaveBeenCalled();

    socket.open();
    socket.open();

    expect(onReconnected).toHaveBeenCalledTimes(2);
  });

  it("resolves a request sent before a reconnect when the response arrives afterwards", async () => {
    const { socket, source } = await connect();

    const pulling = source.pullEvents({ afterSyncId: 0 });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.open();
    const [request] = socket.sent;
    if (request?.type !== "pull-events") {
      throw new Error("Expected a pull request");
    }
    const batch = { events: [], hasMore: false, nextSyncId: 3 };
    socket.receive({ type: "events-pull-response", requestId: request.requestId, data: batch });

    await expect(pulling).resolves.toEqual(batch);
  });

  it("waits for the socket to reopen before sending a request and starting its timeout", async () => {
    vi.useFakeTimers();
    try {
      const { socket, source } = await connect();
      socket.drop();

      const pulling = source.pullEvents({ afterSyncId: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(socket.sent).toHaveLength(0);

      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      const [request] = socket.sent;
      if (request?.type !== "pull-events") {
        throw new Error("Expected a pull request");
      }
      const batch = { events: [], hasMore: false, nextSyncId: 3 };
      socket.receive({ type: "events-pull-response", requestId: request.requestId, data: batch });

      await expect(pulling).resolves.toEqual(batch);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a request waiting for the socket to reopen when the connection closes", async () => {
    const { socket, source, controller } = await connect();
    socket.drop();

    const pushing = source.pushEvents({ nodeId: "node", events: [] });
    controller.abort(new Error("closed"));

    await expect(pushing).rejects.toThrow("closed");
    socket.open();
    expect(socket.sent).toHaveLength(0);
  });
});
