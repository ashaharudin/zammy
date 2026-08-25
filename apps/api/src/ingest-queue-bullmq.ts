import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import {
  PendingSet,
  ingestJobId,
  type IngestHandler,
  type IngestJob,
  type IngestQueue,
  type SampleJob,
  type SegmentJob,
} from "./ingest-queue.js";

/**
 * The queue as a persistent process runs it: jobs in Redis, an in-process
 * BullMQ worker draining them, at-least-once by BLMOVE plus a reaper.
 *
 * This is the Compose and Plan-B implementation and it is not going anywhere.
 * Local development and the integration tests both want a queue that a single
 * `pnpm dev` can serve AND drain, and both want delivery semantics they can
 * assert against a real Redis rather than trust a platform for — which is the
 * test power VERCEL-ALL-IN-SCOPE §3.2 records as lost on the hosted side. It is
 * kept here rather than deleted so that the loss is confined to the deployment
 * that has to take it.
 */
export class BullMqIngestQueue implements IngestQueue {
  private readonly queue: Queue<IngestJob>;
  private readonly redis: Redis;
  private readonly pending: PendingSet;
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
    this.pending = new PendingSet(this.redis, this.queueName);
  }

  async enqueueSegment(job: SegmentJob): Promise<void> {
    await this.queue.add("segment", job, {
      jobId: ingestJobId(job),
      attempts: 3,
      backoff: { type: "exponential", delay: 200 },
      // Completed ids free up for re-adds — a segment may legitimately be
      // fetched again later; dedup only needs to cover the pending window.
      removeOnComplete: true,
      removeOnFail: true,
    });
    await this.pending.add(job);
  }

  async enqueueSample(job: SampleJob): Promise<void> {
    await this.queue.add("sample", job, {
      jobId: ingestJobId(job),
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: true,
    });
    await this.pending.add(job);
  }

  async pendingCount(pendingId: string): Promise<number> {
    return this.pending.count(pendingId);
  }

  async settle(job: IngestJob): Promise<void> {
    await this.pending.remove(job);
  }

  /** Start the in-process consumer (§9.1). One per process. */
  startConsumer(handler: IngestHandler, options: { concurrency?: number } = {}): void {
    if (this.worker) throw new Error("consumer already started");

    this.worker = new Worker<IngestJob>(
      this.queueName,
      async (job) => handler(job.data),
      {
        connection: new Redis(this.redisUrl, { maxRetriesPerRequest: null }),
        concurrency: options.concurrency ?? 1,
      },
    );

    const settle = (job: Job<IngestJob> | undefined): void => {
      if (job) void this.settle(job.data);
    };

    this.worker.on("completed", settle);
    this.worker.on("failed", (job, _error) => {
      // Per-attempt event: only a job that has exhausted its retries is done
      // pending — earlier failures are still outstanding work.
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) settle(job);
    });
  }

  async obliterate(): Promise<void> {
    await this.worker?.close();
    this.worker = null;
    await this.queue.obliterate({ force: true });
    await this.pending.purge();
  }

  get name(): string {
    return this.queueName;
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.redis.quit();
  }
}
