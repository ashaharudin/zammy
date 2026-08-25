import { QueueClient } from "@vercel/queue";
import { ConfigError, loadConfig } from "@zammy/config";
import { parseIngestJob, type IngestHandler, type IngestQueue } from "./ingest-queue.js";
import { MAX_INGEST_DELIVERIES, shouldRetryDelivery } from "./ingest-queue-vercel.js";
import { buildServices, ingestDispatch, type ServiceLogger } from "./server.js";

/**
 * The §9.1 consumer as a Vercel Queues push-mode function
 * (VERCEL-ALL-IN-SCOPE §3.2). `vercel.json` points a `queue/v2beta` trigger at
 * `api/queues/ingest.ts`, which is three lines re-exporting this.
 *
 * It is the sibling of `vercel.ts` and holds the same three properties for the
 * same reasons — build once per instance, load config inside the boot rather
 * than at import, retry a failed boot on the next invocation — with one that is
 * its own:
 *
 *   **This function has no public URL.** Push-mode consumers are reached only
 *   by the platform, so there is no auth code here and none is missing. The
 *   alternative shape, a signed webhook, would have needed some.
 *
 * And one property that is a deliberate difference from `vercel.ts`: this
 * handler must NOT return before its work finishes. The 202-and-`waitUntil`
 * pattern the chores route uses would acknowledge a message whose segment had
 * not been fetched, turning at-least-once into at-most-once for exactly the
 * jobs that take longest.
 */

/**
 * JSON lines to stdout, the shape `chores-cli.ts` logs in and the only shape a
 * platform log collector can do anything with. There is no Fastify instance
 * here to borrow a logger from, and on Hobby these lines survive an hour — the
 * reason `chore_runs` exists on the other route, and the reason this one keeps
 * its own record short and structured.
 */
const emit = (level: string, fields: object, message: string): string =>
  JSON.stringify({ level, msg: message, ...fields });
const log: ServiceLogger = {
  info: (fields, message) => console.log(emit("info", fields, message)),
  warn: (fields, message) => console.warn(emit("warn", fields, message)),
};

/** The half of `Services` a consumer needs. Narrow so it can be faked. */
export interface Drainable {
  queue: Pick<IngestQueue, "settle">;
  dispatch: IngestHandler;
}

/** What the SDK hands a message handler, narrowed to what this reads. */
export interface DeliveryMetadata {
  messageId: string;
  deliveryCount: number;
}

/**
 * The message handler, given something that can drain. Parameterized for the
 * tests: the give-up bound, the settle-on-success and the drop-of-an-unparseable
 * payload are the behaviour worth pinning, and none of it should need a
 * database or a platform to assert.
 */
export function createMessageHandler(
  drainable: Drainable,
  logger: ServiceLogger = log,
): (payload: unknown, metadata: DeliveryMetadata) => Promise<void> {
  return async (payload, metadata) => {
    const job = parseIngestJob(payload);
    if (!job) {
      // Returning rather than throwing acknowledges it. A payload this consumer
      // cannot read will not become readable on the fourth delivery, and there
      // is no dead-letter queue to put it in — so the honest options are "drop
      // it loudly" and "spin until retention expires".
      logger.warn({ messageId: metadata.messageId }, "unrecognised ingest payload; dropping");
      return;
    }

    try {
      await drainable.dispatch(job);
    } catch (error) {
      if (shouldRetryDelivery(metadata.deliveryCount)) {
        // Rethrow: an unacknowledged message is redelivered, which is the whole
        // of at-least-once here. The SDK's `retry` callback is what makes it
        // redeliver SOON rather than when the lease runs out — see the default
        // export.
        throw error;
      }
      // Out of attempts. Settle first: a job nobody will attempt again is not
      // outstanding work, and leaving it in the pending set would hold the
      // topic at `in_progress` until the five-minute stale prune caught it.
      // The gap it names is re-planned by the next reader who finds it unfilled
      // — the same recovery BullMQ's `removeOnFail: true` left us.
      await drainable.queue.settle(job);
      logger.warn(
        {
          messageId: metadata.messageId,
          deliveryCount: metadata.deliveryCount,
          maxDeliveries: MAX_INGEST_DELIVERIES,
          err: error instanceof Error ? error.message : String(error),
        },
        "ingest job failed every delivery; giving up",
      );
      return;
    }

    await drainable.queue.settle(job);
  };
}

/**
 * Config is loaded here rather than at module scope so a bad deploy fails the
 * delivery with a listed reason — and a failed delivery is redelivered, which
 * is the right outcome for a missing environment variable somebody is about to
 * fix.
 */
async function bootFromEnvironment(): Promise<Drainable> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) console.error(error.message);
    throw error;
  }
  if (config.INGEST_QUEUE_DRIVER !== "vercel") {
    // Refuse rather than drain: this function would settle jobs into a pending
    // registry scoped to the same name but published to by a queue nobody here
    // is holding, and the read path would keep reporting them as outstanding.
    throw new Error(
      `INGEST_QUEUE_DRIVER is "${config.INGEST_QUEUE_DRIVER}"; the push-mode consumer requires "vercel"`,
    );
  }

  const services = await buildServices(config, log);
  return { queue: services.queue, dispatch: ingestDispatch(services) };
}

/**
 * The singleton, in the shape `vercel.ts` established: one boot per warm
 * instance, and a failed boot that does not poison the instance for the rest of
 * its life.
 */
function bootOnce(boot: () => Promise<Drainable>): () => Promise<Drainable> {
  let booted: Promise<Drainable> | null = null;
  return () => {
    if (booted) return booted;
    const pending = boot();
    booted = pending;
    pending.catch(() => {
      if (booted === pending) booted = null;
    });
    return pending;
  };
}

const drainable = bootOnce(bootFromEnvironment);

/**
 * `handleNodeCallback`, not the top-level `handleCallback`: the latter returns a
 * Web-standard `POST` handler, and an `api/` function on the Node runtime is
 * handed `(req, res)`.
 *
 * `visibilityTimeoutSeconds` is left at the SDK's default of 300, which also
 * auto-extends the lease while the handler runs — the raw API's 60 s does
 * neither. That default is what makes a long segment fetch safe to await.
 *
 * **And that default is exactly why `retry` cannot be omitted.** Without it a
 * throw simply leaves the message unacknowledged, and it becomes visible again
 * only when the 300 s lease expires — which is also when its 300 s retention
 * expires (§0's TTL decision). The two would cancel out: every failure would be
 * a final failure, and at-least-once would quietly be at-most-once for exactly
 * the jobs that needed the retry. Shortening the lease instead would be the
 * wrong lever, because the lease is what protects a long segment fetch.
 *
 * So the callback exists to say "redeliver soon" and nothing else. It never
 * acknowledges: the handler above already decides when to give up, by returning
 * normally instead of throwing, and it has to be the one to decide because
 * giving up means settling the pending entry — and `retry` is handed the error
 * and the metadata but not the payload, so it could not name the job to settle.
 * The delay is a hint (measured on the spike: +0 s, +10 s, +70 s, +130 s against
 * a requested 5), which is fine — all it has to beat is 300 s.
 */
export default new QueueClient().handleNodeCallback(
  async (payload, metadata) => createMessageHandler(await drainable())(payload, metadata),
  { retry: () => ({ afterSeconds: 5 }) },
);
