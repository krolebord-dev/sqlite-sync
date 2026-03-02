import { durableObjectAdapter, type RemoteHandler } from "@sqlite-sync/cloudflare";
import { type JobRuntime, setupJobs } from "@sqlite-sync/cloudflare/jobs";
import { type Connection, Server } from "partyserver";
import { fetchCurrencyRatesJob } from "./jobs/fetch-currency-rates";
import { jobs } from "./jobs/jobs";
import { syncDbSchema } from "./migrations";

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export class UserDbServer extends Server<Env> {
  static options = {
    hibernate: true,
  };

  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private remoteHandler: RemoteHandler = null!;
  // biome-ignore lint/style/noNonNullAssertion: initialize in onStart
  private jobRuntime: JobRuntime = null!;

  async onStart() {
    const { syncDb, remoteHandler } = durableObjectAdapter.createCrdtStorage({
      syncDbSchema,
      crdtEventsTable: "crdt_events",
      nodeId: this.ctx.id.toString(),
      storage: this.ctx.storage,
      broadcastPayload: (payload) => {
        this.broadcast(payload);
      },
    });

    this.remoteHandler = remoteHandler;

    this.jobRuntime = await setupJobs({
      jobs,
      ctx: this.ctx,
      context: { ctx: this.ctx, env: this.env, syncDb },
    });

    await this.jobRuntime.scheduleInterval(fetchCurrencyRatesJob, {
      input: { baseCurrency: "USD" },
      dedupeKey: "currency-rates",
      everyMs: TWELVE_HOURS_MS,
    });
  }

  async onAlarm() {
    await this.jobRuntime.onAlarm();
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
