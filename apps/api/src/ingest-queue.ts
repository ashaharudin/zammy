import type { Redis } from "ioredis";

/**
 * The deferred-ingestion queue (ARCHITECTURE 9.1). Every job here traces back
 * to a user request — pages a deadline cut off, or halves of a truncated
 * segment (§6.3). At-least-once delivery is what §4.1 makes a deployment
 * requirement: instances are recycled on every deploy, and work held by a dying
 * consumer must be re-delivered, not lost.
 *
 * Idempotent ingestion (§7.4) and idempotent coverage recording are what make
 * at-least-once safe: a re-delivered segment re-fetches and re-upserts, and
 * nothing double-counts.
 *
 * This file is the CONTRACT and the parts that do not depend on a transport.
 * Two implementations satisfy it (VERCEL-ALL-IN-SCOPE §3.2):
 *
 *   - `ingest-queue-bullmq.ts` — Redis-held jobs and an in-process worker. The
 *     Compose shape, and still the one local development runs.
 *   - `ingest-queue-vercel.ts` — a push-mode Vercel Queues topic whose consumer
 *     is a separate deployable with no public URL.
 *
 * What does NOT vary between them is the pending set. `pendingCount` is what
 * `meta.ingest` reports and what the client polls against (§6.5), so keeping
 * that mechanism in Redis under both transports is what leaves the progressive-
 * delivery contract untouched by the swap — the smallest possible blast radius
 * for the riskiest change.
 */

export interface SegmentJob {
  fingerprint: string;
  /** ISO-8601 — job payloads cross a transport as JSON. */
  from: string;
  to: string;
  /** Resume point when a deadline cut a segment mid-paging. */
  startPage: number;
  /**
   * A §6.4 incremental top-up: [max(coverage.upper), now]. Deduplicated by its
   * leading edge alone, because every poll re-reads "now" — under the full
   * (from, to) identity each 1.5s poll would mint a fresh job and multiply
   * quota spend until the first one landed.
   */
  kind?: "topup";
}

/**
 * The §10.1 breadth sample, triggered by the first landing-page visitor after
 * the last snapshot staled. One per language: the Redis first-visitor lock
 * elects the enqueuer and the job identity dedups whatever slips past it. No
 * day key — the window rolls with the clock (ADR-0008), so consecutive samples
 * are the same job identity and the freshness lock is what spaces them.
 */
export interface SampleJob {
  kind: "sample";
  language: string;
}

export type IngestJob = SegmentJob | SampleJob;

export type IngestHandler = (job: IngestJob) => Promise<void>;

/** The pending-set identity a trending read polls (§10.4 meta.ingest). */
export function samplePendingId(job: Pick<SampleJob, "language">): string {
  return `sample_${job.language}`;
}

/**
 * The content address of a job, and the whole of its dedup story under both
 * transports: BullMQ takes it as `jobId`, Vercel Queues as `idempotencyKey`.
 * Exported because the pending set is keyed by it and because it is one of the
 * pure parts the tests can still assert directly once delivery semantics belong
 * to a platform (§3.2).
 */
export function ingestJobId(job: IngestJob): string {
  // Underscores, not colons — BullMQ reserves ':' as its key separator, and
  // Vercel Queues restricts topic names to [A-Za-z0-9_-] besides.
  if (job.kind === "sample") return samplePendingId(job);
  if (job.kind === "topup") return `topup_${job.fingerprint}_${Date.parse(job.from)}`;
  return `seg_${job.fingerprint}_${Date.parse(job.from)}_${Date.parse(job.to)}_p${job.startPage}`;
}

/**
 * Which pending registry a job belongs to: a topic's fingerprint, or the
 * per-language sample slot. Segments and samples are counted separately because
 * they are polled separately — a timeline read asks about its own fingerprint,
 * a trending read asks about `sample_<language>`.
 */
export function pendingIdOf(job: IngestJob): string {
  return job.kind === "sample" ? samplePendingId(job) : job.fingerprint;
}

/**
 * A delivered payload, narrowed — or `null` if it is not a job at all.
 *
 * The in-process worker never needed this: BullMQ handed back the object this
 * process had put in. A hosted queue hands back whatever JSON is on the wire,
 * and the shapes that can arrive are real — a message published by an older
 * deployment whose payload has since changed, or a topic name collision. `null`
 * is what lets the consumer drop such a message deliberately instead of
 * throwing it into a redelivery loop that can only fail the same way.
 */
export function parseIngestJob(payload: unknown): IngestJob | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Record<string, unknown>;
  if (candidate.kind === "sample") {
    return typeof candidate.language === "string" && candidate.language.length > 0
      ? { kind: "sample", language: candidate.language }
      : null;
  }
  if (
    typeof candidate.fingerprint !== "string" ||
    typeof candidate.from !== "string" ||
    typeof candidate.to !== "string" ||
    typeof candidate.startPage !== "number"
  ) {
    return null;
  }
  const job: SegmentJob = {
    fingerprint: candidate.fingerprint,
    from: candidate.from,
    to: candidate.to,
    startPage: candidate.startPage,
  };
  // Carried through explicitly: `kind` is what makes a top-up dedup by its
  // leading edge alone, and a top-up that arrives as a plain segment would mint
  // a fresh job identity on every poll.
  return candidate.kind === "topup" ? { ...job, kind: "topup" } : job;
}

/**
 * Entries older than this are presumed lost to a crashed consumer. It is also
 * the message TTL the Vercel driver publishes with (§0), so the dedup window
 * and the pending window are the same five minutes rather than two numbers that
 * can drift: at the default 24-hour retention a failed run's segment could not
 * be re-enqueued until tomorrow, while its pending entry had long since aged
 * out and the topic read as complete.
 */
export const STALE_PENDING_MS = 5 * 60 * 1000;

/**
 * The transport-independent surface the read path and the consumer share.
 *
 * An interface rather than the class it used to be, because there are now two
 * implementations — but the members are the same ones `timeline-service`,
 * `trending-service` and `server.ts` already used, plus `settle`. `settle` is
 * new and it is new for one reason: BullMQ could clear a pending entry from its
 * own worker events because the worker was in this process, and a push-mode
 * consumer is a different deployable that has to be told.
 */
export interface IngestQueue {
  /**
   * The queue this instance owns. Exposed because the trending keys are scoped
   * by it for the same reason the pending keys are: replicas share the "ingest"
   * queue and must elect ONE sampler, while a differently-named queue — every
   * test harness makes its own — must not touch the state a local dev server is
   * using through the same Redis.
   */
  readonly name: string;

  /**
   * Enqueue a segment, deduplicated by content: every reader who arrives while
   * a gap is unfilled plans the same segments, and without dedup a popular cold
   * topic would enqueue once per reader and multiply quota spend.
   */
  enqueueSegment(job: SegmentJob): Promise<void>;

  /** Enqueue the breadth sample (§10.1). One per language. */
  enqueueSample(job: SampleJob): Promise<void>;

  /**
   * Outstanding jobs for a topic — meta.ingest.pendingJobs (§6.1) — or for a
   * sample when given a samplePendingId.
   */
  pendingCount(pendingId: string): Promise<number>;

  /**
   * Mark a delivered job no longer outstanding. The counterpart to enqueue, and
   * the consumer's last act on the happy path — or its act on a poisoned
   * message it has decided to stop retrying, since a job nobody will attempt
   * again is not pending work.
   */
  settle(job: IngestJob): Promise<void>;

  /**
   * Start a consumer inside THIS process. Only the BullMQ driver can: under
   * Vercel Queues the consumer is its own function and this throws.
   */
  startConsumer(handler: IngestHandler, options?: { concurrency?: number }): void;

  /** Test hygiene: drop every trace of this queue that we own. */
  obliterate(): Promise<void>;

  close(): Promise<void>;
}

/**
 * The Redis registry behind `meta.ingest.pendingJobs`, shared verbatim by both
 * transports.
 *
 * It is deliberately NOT the queue: a hosted queue will not tell us "how much
 * work is outstanding for this one topic", and the client's poll loop needs
 * exactly that. Keeping our own ledger also gives §3.2's named fallback
 * something to read if the beta trigger regresses — what is owed survives in
 * Redis whether or not anything is draining it.
 */
export class PendingSet {
  constructor(
    private readonly redis: Redis,
    private readonly queueName: string,
  ) {}

  async add(job: IngestJob): Promise<void> {
    // NX: re-enqueueing a duplicate must not refresh its timestamp, or a
    // permanently-re-requested job could never go stale.
    await this.redis.zadd(this.key(pendingIdOf(job)), "NX", Date.now(), ingestJobId(job));
  }

  async remove(job: IngestJob): Promise<void> {
    await this.redis.zrem(this.key(pendingIdOf(job)), ingestJobId(job));
  }

  /**
   * Entries older than STALE_PENDING_MS are pruned as crashed-consumer residue,
   * so a lost decrement degrades to "in_progress for five minutes", never to a
   * topic that reads as perpetually warming.
   */
  async count(pendingId: string): Promise<number> {
    const key = this.key(pendingId);
    await this.redis.zremrangebyscore(key, 0, Date.now() - STALE_PENDING_MS);
    return this.redis.zcard(key);
  }

  async purge(): Promise<void> {
    const keys = await this.redis.keys(this.key("*"));
    if (keys.length > 0) await this.redis.del(...keys);
  }

  private key(pendingId: string): string {
    // Scoped to the queue: replicas share the "ingest" queue and therefore the
    // registry, while a differently-named queue (tests) cannot leak pending
    // state into this one's counts.
    return `ingest:pending:${this.queueName}:${pendingId}`;
  }
}
