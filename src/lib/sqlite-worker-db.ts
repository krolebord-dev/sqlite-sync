import { startPerformanceLogger, type Logger } from "./logger";
import { createDeferredPromise, type DeferredPromise } from "./utils";
import {
  createBroadcastChannels,
  isWorkerInitResponse,
  isWorkerNotificationMessage,
  isWorkerResponseMessage,
} from "./worker-common";
import type {
  AsyncRpc,
  GetSnapshotResponse,
  PullEventsResponse,
  WorkerBroadcastChannels,
  WorkerInitMessage,
  WorkerNotificationMessage,
  WorkerRequestMessage,
  WorkerRequestMethod,
  WorkerResponseMessage,
  WorkerRpc,
} from "./worker-common";
import type { ExecuteParams, ExecuteResult } from "./sqlite-db-wrapper";
import type { PersistedCrdtEvent } from "./sqlite-crdt/crdt-table-schema";

type SQLiteWorkerDbOptions = {
  dbPath: string;
  logger: Logger;
  tabId: string;
  clientId: string;
  worker: Worker;
  onNotification?: (notification: WorkerNotificationMessage) => void;
};

export class SQLiteWorkerDb implements AsyncRpc<WorkerRpc> {
  private readonly tabId: string;
  private readonly clientId: string;
  private readonly dbPath: string;

  private readonly broadcastChannels: WorkerBroadcastChannels;

  private readonly worker: Worker;

  private readonly onNotification?: (
    notification: WorkerNotificationMessage
  ) => void;

  private readonly workerRequestsMap = new Map<
    string,
    DeferredPromise<unknown>
  >();

  private constructor(opts: SQLiteWorkerDbOptions) {
    this.worker = opts.worker;
    this.tabId = opts.tabId;
    this.clientId = opts.clientId;
    this.dbPath = opts.dbPath;
    this.onNotification = opts.onNotification;
    this.broadcastChannels = createBroadcastChannels();
  }

  getSnapshot(): Promise<GetSnapshotResponse> {
    return this.queryWorker("getSnapshot", []);
  }

  pushLocalEvents(nodeId: string, events: PersistedCrdtEvent[]): Promise<void> {
    return this.queryWorker("pushLocalEvents", [nodeId, events]);
  }

  execute(query: ExecuteParams): Promise<ExecuteResult<unknown>> {
    return this.queryWorker("execute", [query]);
  }

  pullEvents(params: {
    startFromSyncId: number;
    excludeNodeId: string;
  }): Promise<PullEventsResponse> {
    return this.queryWorker("pullEvents", [params]);
  }

  postInitReady(): Promise<void> {
    return this.queryWorker("postInitReady", []);
  }

  public static async create(opts: Omit<SQLiteWorkerDbOptions, "worker">) {
    const perf = startPerformanceLogger(opts.logger);

    const worker = new Worker(new URL("./worker", import.meta.url), {
      type: "module",
    });

    const workerDb = new SQLiteWorkerDb({
      ...opts,
      worker,
    });

    await workerDb.initialize();

    perf.logEnd("createWorkerDb", opts.dbPath, "info");

    return workerDb;
  }

  private async initialize() {
    await this.waitWorkerInit();

    this.broadcastChannels.responses.onmessage = (event) => {
      const message = event.data;

      if (isWorkerResponseMessage(message)) {
        this.handleWorkerResponse(message);
      } else if (isWorkerNotificationMessage(message)) {
        this.handleWorkerNotification(message);
      }
    };
  }

  private queryWorker<TMethod extends WorkerRequestMethod>(
    method: TMethod,
    args: Parameters<WorkerRpc[TMethod]>
  ): Promise<ReturnType<WorkerRpc[TMethod]>> {
    const requestId = crypto.randomUUID();
    const promise = createDeferredPromise<unknown>();
    this.workerRequestsMap.set(requestId, promise);

    const request: WorkerRequestMessage<TMethod> = {
      type: "request",
      requestId,
      method,
      args,
    };

    this.broadcastChannels.requests.postMessage(request);

    return promise.promise as Promise<ReturnType<WorkerRpc[TMethod]>>;
  }

  private handleWorkerResponse(message: WorkerResponseMessage) {
    const promise = this.workerRequestsMap.get(message.requestId);
    if (!promise) {
      return;
    }

    promise.resolve(message.data);
    this.workerRequestsMap.delete(message.requestId);
  }

  private handleWorkerNotification(message: WorkerNotificationMessage) {
    this.onNotification?.(message);
  }

  private async waitWorkerInit() {
    const promise = createDeferredPromise<void>();
    this.broadcastChannels.responses.onmessage = (event) => {
      const message = event.data;
      if (!isWorkerInitResponse(message)) {
        return;
      }
      promise.resolve();
      this.worker.onmessage = null;
    };

    const config: WorkerInitMessage = {
      type: "init",
      config: {
        dbPath: this.dbPath,
        tabId: this.tabId,
        clientId: this.clientId,
        clearOnInit: window.location.search.includes("clear"),
      },
    };
    this.worker.postMessage(config);
    this.broadcastChannels.requests.postMessage({
      type: "request",
      requestId: crypto.randomUUID(),
      method: "postInitReady",
      args: [],
    });

    return promise.promise;
  }
}
