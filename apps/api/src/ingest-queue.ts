import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

/**
 * The deferred-ingestion queue (ARCHITECTURE 9.1). Every job here traces back
 * to a user request — pages a deadline cut off, or halves of a truncated
 * segment (§6.3). BullMQ provides the at-least-once delivery that §4.1 makes a
 * deployment requirement: tasks are recycled on every deploy, and work held by
 * a dying consumer must be re-delivered, not lost.
 *
 * Idempotent ingestion (§7.4) and idempotent coverage recording are what make
 * at-least-once safe: a re-delivered segment re-fetches and re-upserts, and
 * nothing double-counts.
 */

export interface SegmentJob {
  fingerprint: string;
  /** ISO-8601 — job payloads live in Redis as JSON. */
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
 * The §10.1 daily breadth sample, triggered by the first landing-page visitor
 * of the day. One per (day, language): the Redis first-visitor lock elects
 * the enqueuer and the jobId dedups whatever slips past it.
 */
export interface SampleJob {
  kind: "sample";
  /** APP_TIMEZONE day key, YYYY-MM-DD (§10.1). */
  day: string;
  language: string;
}

export type IngestJob = SegmentJob | SampleJob;

/** The pending-set identity a trending read polls (§10.4 meta.ingest). */
export function samplePendingId(job: Pick<SampleJob, "day" | "language">): string {
  return `sample_${job.day}_${job.language}`;
}

/** Entries older than this are presumed lost to a crashed consumer (see below). */
const STALE_PENDING_MS = 5 * 60 * 1000;

export class IngestQueue {
  private readonly queue: Queue<IngestJob>;
  private readonly redis: Redis;
  private worker: Worker<IngestJob> | null = null;
  private readonly queueName: string;

  constructor(
    private readonly redisUrl: string,
    options: { queueName?: string } = {},
  ) {
    this.queueName = options.queueName ?? "ingest";
    // BullMQ requires maxRetriesPerRequest: null on its connections.
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<IngestJob>(this.queueName, { connection: this.redis });
  }

  /**
   * Enqueue a segment, deduplicated by content: every reader who arrives while
   * a gap is unfilled plans the same segments, and without dedup a popular
   * cold topic would enqueue once per reader and multiply quota spend.
   */
  async enqueueSegment(job: SegmentJob): Promise<void> {
    const jobId = ingestJobId(job);
    await this.queue.add("segment", job, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 200 },
      // Completed ids free up for re-adds — a segment may legitimately be
      // fetched again later; dedup only needs to cover the pending window.
      removeOnComplete: true,
      removeOnFail: true,
    });
    // NX: re-enqueueing a duplicate must not refresh its timestamp, or a
    // permanently-re-requested job could never go stale.
    await this.redis.zadd(this.pendingKey(job.fingerprint), "NX", Date.now(), jobId);
  }

  /** Enqueue the day's breadth sample (§10.1). One per (day, language). */
  async enqueueSample(job: SampleJob): Promise<void> {
    const jobId = ingestJobId(job);
    await this.queue.add("sample", job, {
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    await this.redis.zadd(this.pendingKey(samplePendingId(job)), "NX", Date.now(), jobId);
  }

  /**
   * Outstanding jobs for a topic — meta.ingest.pendingJobs (§6.1) — or for a
   * daily sample when given a samplePendingId. Entries older than
   * STALE_PENDING_MS are pruned as crashed-consumer residue, so a lost
   * decrement degrades to "in_progress for five minutes", never to a topic
   * that reads as perpetually warming.
   */
  async pendingCount(fingerprint: string): Promise<number> {
    const key = this.pendingKey(fingerprint);
    await this.redis.zremrangebyscore(key, 0, Date.now() - STALE_PENDING_MS);
    return this.redis.zcard(key);
  }

  /** Start the in-process consumer (§9.1). One per process. */
  startConsumer(
    handler: (job: IngestJob) => Promise<void>,
    options: { concurrency?: number } = {},
  ): void {
    if (this.worker) throw new Error("consumer already started");

    this.worker = new Worker<IngestJob>(
      this.queueName,
      async (job) => handler(job.data),
      {
        connection: new Redis(this.redisUrl, { maxRetriesPerRequest: null }),
        concurrency: options.concurrency ?? 1,
      },
    );

    const settle = async (job: Job<IngestJob> | undefined): Promise<void> => {
      if (!job) return;
      const pendingId =
        job.data.kind === "sample" ? samplePendingId(job.data) : job.data.fingerprint;
      await this.redis.zrem(this.pendingKey(pendingId), ingestJobId(job.data));
    };

    this.worker.on("completed", (job) => void settle(job));
    this.worker.on("failed", (job, _error) => {
      // Per-attempt event: only a job that has exhausted its retries is done
      // pending — earlier failures are still outstanding work.
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void settle(job);
    });
  }

  /** Test hygiene: drop every trace of this queue from Redis. */
  async obliterate(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
    await this.queue.obliterate({ force: true });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.redis.quit();
  }

  private pendingKey(fingerprint: string): string {
    return `ingest:pending:${fingerprint}`;
  }
}

function ingestJobId(job: IngestJob): string {
  // Underscores, not colons — BullMQ reserves ':' as its key separator.
  if (job.kind === "sample") return samplePendingId(job);
  if (job.kind === "topup") return `topup_${job.fingerprint}_${Date.parse(job.from)}`;
  return `seg_${job.fingerprint}_${Date.parse(job.from)}_${Date.parse(job.to)}_p${job.startPage}`;
}
