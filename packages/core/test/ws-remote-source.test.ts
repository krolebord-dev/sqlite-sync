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
    this.dispatchEvent(new Event("close"));
  }

  receive(message: SyncServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const connect = (socket = new FakeSocket()) => {
  const onEventsAvailable = vi.fn();
  const onClosed = vi.fn();
  const source = createWsRemoteSource({ createWebSocket: () => socket as never })({ onEventsAvailable, onClosed });
  return { socket, source, onEventsAvailable, onClosed };
};

const respondToPull = (socket: FakeSocket, nextSyncId: number) => {
  const request = socket.sent.at(-1);
  if (request?.type !== "pull-events") {
    throw new Error("Expected a pull request");
  }
  const batch = { events: [], hasMore: false, nextSyncId };
  socket.receive({ type: "events-pull-response", requestId: request.requestId, data: batch });
  return batch;
};

describe("createWsRemoteSource", () => {
  it("sends requests once the socket opens", async () => {
    const { socket, source } = connect();

    const pulling = source.pullEvents({ afterSyncId: 0 });
    await Promise.resolve();
    expect(socket.sent).toHaveLength(0);

    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const batch = respondToPull(socket, 3);

    await expect(pulling).resolves.toEqual(batch);
  });

  it("sends requests right away on a socket that is already open", async () => {
    const socket = new FakeSocket();
    socket.readyState = WebSocket.OPEN;
    const { source } = connect(socket);

    const pulling = source.pullEvents({ afterSyncId: 0 });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const batch = respondToPull(socket, 3);

    await expect(pulling).resolves.toEqual(batch);
  });

  it("reports the first close, rejects pending requests, and closes the socket", async () => {
    const { socket, source, onClosed } = connect();
    socket.open();
    const pulling = source.pullEvents({ afterSyncId: 0 });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    socket.drop();
    socket.drop();

    await expect(pulling).rejects.toThrow("WebSocket closed");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("rejects requests without sending them once the socket has closed", async () => {
    const { socket, source } = connect();
    const waiting = source.pushEvents({ nodeId: "node", events: [] });

    socket.drop();
    socket.open();

    await expect(waiting).rejects.toThrow("WebSocket closed");
    await expect(source.pullEvents({ afterSyncId: 0 })).rejects.toThrow("WebSocket closed");
    expect(socket.sent).toHaveLength(0);
  });

  it("closes the socket on disconnect without reporting a close", async () => {
    const { socket, source, onClosed } = connect();
    socket.open();
    const pulling = source.pullEvents({ afterSyncId: 0 });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));

    source.disconnect?.();
    socket.drop();

    await expect(pulling).rejects.toThrow("WebSocket closed");
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("reports broadcast events", () => {
    const { socket, onEventsAvailable } = connect();
    socket.open();

    socket.receive({ type: "events-applied", newSyncId: 7, eventHlcSum: "sum" });

    expect(onEventsAvailable).toHaveBeenCalledWith({ newSyncId: 7, remoteEventHlcSum: "sum" });
  });
});
