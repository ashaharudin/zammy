import { QueueClient } from "@vercel/queue";
import { ConfigError, loadConfig } from "@zammy/config";
import {
  ingestJobId,
  parseIngestJob,
  type IngestHandler,
  type IngestQueue,
} from "./ingest-queue.js";
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
 * not been fetched, losing exactly the jobs that take longest.
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
    // One line per DELIVERY, before any work. This is the only observability the
    // queue has: `/metrics` is deleted (§7), `chore_runs` covers the chores and
    // not this, and Hobby keeps an hour of logs. Without it a 200 from this
    // function is ambiguous — the SDK answers 200 for a success, for a message
    // it has rescheduled after a throw, AND for one given up on, so the status
    // code alone cannot tell you whether anything drained. `deliveryCount` is
    // the field that makes redelivery visible; it starts at 1.
    logger.info(
      {
        messageId: metadata.messageId,
        deliveryCount: metadata.deliveryCount,
        job: job ? ingestJobId(job) : null,
      },
      "ingest delivery",
    );
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
        // Rethrow, which answers 500 and leaves the message unacknowledged —
        // what at-least-once is supposed to be built on. MEASURED CAVEAT: the
        // platform does not currently redeliver it (see the default export), so
        // in production this branch is where a failed job is lost rather than
        // retried. It stays because it is the correct contract and the one the
        // BullMQ driver honours; what covers the gap meanwhile is that the
        // pending entry is NOT settled here, so `meta.ingest` keeps reporting
        // the work as owed until the five-minute stale prune, and the next
        // reader re-plans the gap it named.
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
    logger.info(
      {
        messageId: metadata.messageId,
        deliveryCount: metadata.deliveryCount,
        job: ingestJobId(job),
      },
      "ingest job settled",
    );
  };
}

/**
 * Config is loaded here rather than at module scope so a bad deploy fails the
 * delivery with a listed reason in the log, rather than as whatever the platform
 * makes of a module that throws during import. Note this is NOT a recoverable
 * situation the way it would be on a queue that retried: a delivery lost to a
 * missing environment variable is lost (see the default export), and what
 * recovers the work is the next reader re-planning the gap.
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
 * **There is no `retry` callback, and the reason is measured rather than
 * reasoned.** Both shapes were deployed against a deliberately poisoned message
 * (2026-08-25, preview) and neither produced a second delivery:
 *
 *   - **With** `retry: () => ({ afterSeconds: 5 })`, the SDK catches the throw,
 *     calls `changeVisibility` — successfully, since it logs
 *     "Failed to reschedule message for retry" when that call fails and it did
 *     not — and then returns normally, so the callback answers **200**. No
 *     redelivery followed, across the message's whole 300 s retention.
 *   - **Without** it, the error propagates and the callback answers **500**.
 *     Also exactly one delivery, watched for 440 s.
 *
 * So redelivery is not currently happening either way, and between two shapes
 * that both lose the message the honest one wins: a 500 puts the failure in the
 * platform's own request log, where it is visible without reading ours, and it
 * is the shape that starts working if the beta begins honouring failed
 * callbacks. The `retry` callback's 200 would hide the same failure behind a
 * success. See VERCEL-ALL-IN-SCOPE §3.2 — this is the beta risk ADR-0015
 * accepted, and the pending set is the ledger that covers it.
 *
 * `shouldRetryDelivery` and the give-up path below are therefore correct but
 * **unexercised in production**: `deliveryCount` has never been observed above
 * 1. They are kept because they are what the contract says should happen, and
 * because the BullMQ driver genuinely does it.
 */
export default new QueueClient().handleNodeCallback(async (payload, metadata) =>
  createMessageHandler(await drainable())(payload, metadata),
);
