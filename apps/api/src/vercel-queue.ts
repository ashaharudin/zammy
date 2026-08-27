import { QueueClient } from "@vercel/queue";
import { ConfigError, loadConfig } from "@zammy/config";
import {
  ingestJobId,
  parseIngestJob,
  type IngestHandler,
  type IngestQueue,
} from "./ingest-queue.js";
import {
  MAX_INGEST_DELIVERIES,
  isPermanentIngestFailure,
  shouldRetryDelivery,
} from "./ingest-queue-vercel.js";
import { waitForRedis } from "./redis-ready.js";
import { buildServices, ingestDispatch, type ServiceLogger, type Services } from "./server.js";

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
      if (isPermanentIngestFailure(error)) {
        // Settle and drop on the FIRST delivery. The retry budget exists for a
        // world that might have changed by +305s; a revoked key and a
        // fingerprint ban are not that, so spending three deliveries and ~610s
        // of latency on one buys nothing and hides the cause behind two more
        // identical failures in the log. The bar for landing on that list is
        // high and the reasoning for it is in `isPermanentIngestFailure` — in
        // particular why a 400 is NOT on it.
        //
        // Settling matters as much as dropping: an unsettled entry holds the
        // topic at `in_progress` until the fifteen-minute stale prune, so a
        // reader is told the fill is still coming when nothing will attempt it
        // again.
        await drainable.queue.settle(job);
        logger.warn(
          {
            messageId: metadata.messageId,
            deliveryCount: metadata.deliveryCount,
            job: ingestJobId(job),
            err: error.message,
            kind: error.kind,
            provider: error.provider,
          },
          "ingest job failed for a reason no redelivery can fix; dropping",
        );
        return;
      }
      if (shouldRetryDelivery(metadata.deliveryCount)) {
        // Rethrow, which answers 500 and leaves the message unacknowledged —
        // what at-least-once is built on. The redelivery arrives ~305 s later,
        // when the visibility lease expires; the 500 is for the platform's
        // request log rather than for the retry, which happens either way.
        //
        // Note the pending entry is deliberately NOT settled here, and that the
        // stale prune can no longer beat the redelivery: `STALE_PENDING_MS` is
        // fifteen minutes, past the whole ~610 s budget, so the entry survives
        // and `meta.ingest` keeps reporting the job the queue still intends to
        // deliver. It was five minutes until 2026-08-25, which pruned the entry
        // with attempt 2 only 5 s away — and a topic that then read `complete`
        // is a topic `timeline-service` caches mid-fill.
        throw error;
      }
      // Out of attempts. Settle first: a job nobody will attempt again is not
      // outstanding work, and leaving it in the pending set would hold the
      // topic at `in_progress` until the fifteen-minute stale prune caught it.
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
  return drainableFrom(services);
}

/**
 * The rest of the boot, given built services: wait for Redis, then hand back
 * something that can drain. Separated from `bootFromEnvironment` because the
 * wait is the part worth pinning and the part around it needs a platform, a
 * database and an upstream.
 *
 * **The wait is the whole point of this function.** `buildServices` connects its
 * Redis client in the background on purpose — `lazyConnect`,
 * `enableOfflineQueue: false`, an un-awaited `connect()` — because on the
 * request path Redis is pure cache and awaiting Upstash's ~800 ms handshake
 * would sit in front of every cold timeline read. See `redis-ready.ts`; that
 * posture stays.
 *
 * For this consumer it is wrong, in the same way it was wrong for the drain, and
 * for the same reason: the boot returns and a job runs immediately against a
 * client that may still be shaking hands, where a disabled offline queue makes
 * ioredis throw `Stream isn't writeable` rather than wait.
 *
 * Unlike the drain this has never actually failed, and the reason is TIMING
 * LUCK rather than any ordering guarantee. Both handlers happen to make a
 * Postgres round trip before their first Redis command — `processSegmentJob`
 * reads the topic before `tryAcquire` takes the segment lock, `processSampleJob`
 * upserts the topic first — and a warm same-region pooler query has been
 * winning that race against a cold handshake. It got NARROWER at the Supabase
 * cutover, not wider: production is now us-east-1 beside Vercel's iad1, so the
 * Postgres half of the race got faster while the handshake did not.
 *
 * And the way it would present is worse than a 500. `tryAcquire` throwing is
 * caught as a failed job, so the message comes back at +305 s and +610 s before
 * anything gives up — and the error reads as the legitimate case sitting three
 * lines away in that same function, "segment ... is locked; retrying later".
 * Lock contention and a connection that was never ready are not the same
 * problem, and a fix aimed at the wrong one of them is an afternoon.
 *
 * A rejection here fails the boot rather than the job. That is the outcome we
 * want: `bootOnce` drops the failed promise so the next delivery retries the
 * whole thing, and the log line names Redis instead of a lock.
 */
/**
 * Wait for Redis, and close the services if it never arrives.
 *
 * The close is not tidiness. `buildServices` unwinds its own failures through an
 * `abandon` list, but that only covers throws INSIDE it — this wait happens one
 * layer up, after it has already returned a fully built pool and client. Without
 * the close, a rejection escapes with both still open and nothing holding a
 * reference to them, which is precisely the hazard server.ts:172 was written
 * about: "anything this attempt left open leaks once per invocation for the life
 * of an instance that lives for hours". `bootOnce` drops a failed boot so the
 * next invocation retries the whole thing, so an unreachable Redis would
 * otherwise leak a `DATABASE_POOL_MAX`-sized pool per retry against a
 * free-tier connection budget.
 *
 * `close()` failing must not mask the reason the boot failed, so it is
 * swallowed — the caller wants "Redis was not ready", not whatever `pool.end()`
 * made of a half-open connection.
 */
async function readyOrClose(services: Services): Promise<void> {
  try {
    await waitForRedis(services.redis);
  } catch (error) {
    await services.close().catch(() => {});
    throw error;
  }
}

export async function drainableFrom(services: Services): Promise<Drainable> {
  await readyOrClose(services);
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
 * reasoned.** Rethrowing answers 500 and leaves the message unacknowledged,
 * which is what at-least-once is built on; the callback's response code turns
 * out not to be what triggers redelivery at all. A failed delivery comes back
 * when its VISIBILITY LEASE EXPIRES — measured at +305 s, server-assigned,
 * unaffected by the response code, by `retryAfterSeconds` in `vercel.json`, or
 * by the SDK's `visibilityTimeoutSeconds`. See
 * `OBSERVED_REDELIVERY_LEASE_SECONDS`.
 *
 * A `retry: () => ({ afterSeconds: n })` callback was measured too, and is not
 * used, for two reasons that survived the measurement: it makes the SDK answer
 * **200** and so hides a genuine failure from the platform's own request log,
 * and its `afterSeconds` is not honoured for the first redelivery either. The
 * one thing it did change was the cadence AFTER the first retry (60 s rather
 * than a further 305 s) — an effect we cannot explain from the SDK source, and
 * not a good enough reason to report failures as successes.
 *
 * **This function's history is worth keeping.** Until 2026-08-25 a failed job
 * here was LOST, and the cause was not the callback shape: the driver published
 * with `retentionSeconds` equal to the pending window of the day (300 s), so a
 * message was deleted five seconds before its first redelivery was due and the
 * retry window was exactly zero. Raising the retention is what fixed it
 * (`INGEST_RETENTION_SECONDS`), and nothing in this file had to change —
 * VERCEL-ALL-IN-SCOPE §10 question 0.
 *
 * So `shouldRetryDelivery` and the give-up path below are now genuinely
 * exercised: a poisoned job is delivered at +0 s, +305 s and +610 s, and the
 * third settles and gives up.
 */
export default new QueueClient().handleNodeCallback(async (payload, metadata) =>
  createMessageHandler(await drainable())(payload, metadata),
);
