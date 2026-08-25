import { Redis } from "ioredis";
import { QueueClient } from "@vercel/queue";
import {
  PendingSet,
  STALE_PENDING_MS,
  ingestJobId,
  type IngestHandler,
  type IngestJob,
  type IngestQueue,
  type SampleJob,
  type SegmentJob,
} from "./ingest-queue.js";

/**
 * The queue as Vercel runs it (VERCEL-ALL-IN-SCOPE §3.2): a hosted topic in
 * push mode, whose consumer is `api/queues/ingest.ts` — a function with no
 * public URL, reached only by the platform. That air gap is why there is no
 * auth code here: the alternative shape, a signed webhook, would need some.
 *
 * What this class is NOT is a consumer. Publishing and draining are separate
 * deployables now, and the one thing this file must never grow is a way to
 * start a worker in a request instance — the failure the whole plan is arranged
 * to avoid. `startConsumer` therefore throws rather than no-ops, because a
 * silent no-op is a topic that reads as perpetually warming.
 *
 * Two properties observed on the spike rather than read, both load-bearing:
 *
 *   - **Dedup deduplicates DELIVERY, not publish.** Publishing twice with the
 *     same `idempotencyKey` returns two different message ids and does not
 *     throw, but only one consumer invocation follows. That is the property
 *     that matters, since BullMQ's `jobId` also prevents duplicate *processing*
 *     rather than duplicate enqueueing — so a repeat publish is not an error
 *     here and must not be treated as one.
 *   - **Topics are partitioned by deployment id.** A deploy mid-flight leaves
 *     the old deployment draining its own messages. Better than BullMQ jobs
 *     outliving the code that wrote them, but a different failure mode: work
 *     published by a deployment that is then rolled back is consumed by a
 *     deployment nobody is serving from. The pending set is what still reports
 *     it as owed.
 */

/**
 * Attempts before a message is acknowledged away. Three, to match the BullMQ
 * driver's `attempts: 3` — the retry budget is a property of the work (an
 * upstream blip, a contended segment lock) rather than of the transport, and
 * two transports disagreeing about it would make "how hard do we try" depend on
 * where the code happens to be running.
 *
 * There is no dead-letter queue. A message past its budget is dropped, and the
 * segment it named is re-planned by the next reader who finds the gap still
 * unfilled — which is the same recovery BullMQ's `removeOnFail: true` left us.
 */
export const MAX_INGEST_DELIVERIES = 3;

/**
 * Whether a failed delivery is worth another, as a pure function of the count
 * so the consumer's decision is testable without a platform.
 *
 * The count is the half of the spike's observation that held exactly: a
 * poisoned message redelivered at +0s, +10s, +70s and +130s against a requested
 * `afterSeconds: 5`, so the DELAY is a hint and nothing here depends on it.
 * `deliveryCount` starts at 1 on the first delivery.
 */
export function shouldRetryDelivery(deliveryCount: number): boolean {
  return deliveryCount < MAX_INGEST_DELIVERIES;
}

/** The publish half of the SDK, narrowed to what this needs so it can be faked. */
export type PublishMessage = (
  topic: string,
  payload: IngestJob,
  options: { idempotencyKey: string; retentionSeconds: number },
) => Promise<{ messageId: string | null }>;

/** The narrow logger this needs, satisfied by Fastify's and by a CLI's own. */
export interface QueueLogger {
  warn(fields: object, message: string): void;
}

export interface VercelIngestQueueOptions {
  /** Doubles as the Vercel Queues topic name; `vercel.json`'s trigger must match. */
  queueName?: string;
  publish?: PublishMessage;
  log?: QueueLogger;
}

export class VercelIngestQueue implements IngestQueue {
  private readonly redis: Redis;
  private readonly pending: PendingSet;
  private readonly topic: string;
  private readonly publish: PublishMessage;
  private readonly log: QueueLogger | undefined;

  constructor(redisUrl: string, options: VercelIngestQueueOptions = {}) {
    this.topic = options.queueName ?? "ingest";
    this.log = options.log;
    // `maxRetriesPerRequest: 2` so a genuinely unreachable Redis fails fast
    // rather than hanging a request behind a reconnect storm — but the OFFLINE
    // QUEUE stays on, unlike `server.ts`'s cache client. A cold instance boots
    // and serves its first request in well under the ~800 ms an Upstash
    // handshake takes (measured, Phase 1), so with commands rejected until the
    // socket is up the very first enqueue of every cold start would lose its
    // ledger entry. Queue them instead; they are bounded by the retry count.
    //
    // An `error` listener is not optional: ioredis makes an unhandled one
    // fatal, and a queue that kills the instance on a blip is worse than one
    // that miscounts.
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 2 });
    this.redis.on("error", (error: unknown) =>
      this.log?.warn({ err: error }, "ingest queue redis error"),
    );
    this.pending = new PendingSet(this.redis, this.topic);
    // Bound here rather than at module scope: the client resolves its region
    // from VERCEL_REGION on first use, and a module-scope instance would warn
    // about the fallback in every process that merely imports this file.
    this.publish = options.publish ?? new QueueClient().send;
  }

  async enqueueSegment(job: SegmentJob): Promise<void> {
    // Publish FIRST and let it throw: the message is the durable half, and a
    // caller told the enqueue succeeded when it did not would leave a gap
    // nothing is going to fill.
    await this.send(job);
    await this.ledger(() => this.pending.add(job), undefined, "add");
  }

  async enqueueSample(job: SampleJob): Promise<void> {
    await this.send(job);
    await this.ledger(() => this.pending.add(job), undefined, "add");
  }

  async pendingCount(pendingId: string): Promise<number> {
    return this.ledger(() => this.pending.count(pendingId), 0, "count");
  }

  async settle(job: IngestJob): Promise<void> {
    await this.ledger(() => this.pending.remove(job), undefined, "remove");
  }

  startConsumer(_handler: IngestHandler, _options?: { concurrency?: number }): never {
    throw new Error(
      "the Vercel Queues consumer is its own deployable (api/queues/ingest.ts); " +
        "this driver cannot start one in-process",
    );
  }

  /**
   * The pending set only. A hosted topic's messages are not ours to drop, and
   * they expire on their own within STALE_PENDING_MS anyway — which is the
   * other thing the short TTL buys.
   */
  async obliterate(): Promise<void> {
    await this.pending.purge();
  }

  get name(): string {
    return this.topic;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * A pending-set operation, degraded to best-effort.
   *
   * This is the one posture the BullMQ driver could not have: there, Redis WAS
   * the queue, so a Redis outage failed the enqueue and there was nothing finer
   * to say. Here the message is already safe in a hosted topic and the pending
   * set is a progress hint — so failing a timeline read because the hint could
   * not be written would trade a working page for an accurate spinner. What it
   * costs when Redis is down is that `meta.ingest` under-reports and the client
   * stops polling early; the fill still lands, and the next read sees it.
   *
   * Same fail-open direction §3.4's quota governor and §3.5's rate limit take,
   * for the same reason: Redis is not on the critical path of answering.
   */
  private async ledger<T>(op: () => Promise<T>, fallback: T, what: string): Promise<T> {
    try {
      return await op();
    } catch (error) {
      this.log?.warn(
        { op: what, err: error instanceof Error ? error.message : String(error) },
        "ingest pending set unavailable; meta.ingest will under-report",
      );
      return fallback;
    }
  }

  private async send(job: IngestJob): Promise<void> {
    await this.publish(this.topic, job, {
      idempotencyKey: ingestJobId(job),
      // Not the 24-hour default (§0). Billed at 2x the operation, which is the
      // price of dedup.
      retentionSeconds: STALE_PENDING_MS / 1000,
    });
  }
}
