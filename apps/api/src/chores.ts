import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import { retentionReport, type Database, type RetentionReport } from "@zammy/storage";

/**
 * Non-upstream chores (ARCHITECTURE 9.1): work with a clock but no quota
 * cost. Currently one — the nightly retention REPORT (§7.5, ADR-0001).
 *
 * The schedule lives in BullMQ's job scheduler, which is Redis-shared state:
 * N Fargate tasks register the same scheduler id and exactly one instance
 * runs each night's job — the distributed-lock problem §4.1 warned about,
 * solved by the queue we already run.
 */

/** §7.5: a topic hit within this window still protects its articles. */
const TOPIC_IDLE_DAYS = 30;

export interface ChoreDeps {
  db: Kysely<Database>;
  config: { retentionDays: number };
  now: () => Date;
  log: { info: (obj: object, msg: string) => void };
}

/**
 * Run the report and put it in the structured log — that IS the deliverable.
 * Deletion is a later, deliberate decision (ADR-0001), so the numbers must be
 * visible long before any code acts on them.
 */
export async function runRetentionChore(deps: ChoreDeps): Promise<RetentionReport> {
  const report = await retentionReport(deps.db, {
    retentionDays: deps.config.retentionDays,
    topicIdleDays: TOPIC_IDLE_DAYS,
    now: deps.now(),
  });
  deps.log.info(
    { report, retentionDays: deps.config.retentionDays, topicIdleDays: TOPIC_IDLE_DAYS },
    "retention report — report-only, nothing deleted (ADR-0001)",
  );
  return report;
}

export class ChoreQueue {
  private readonly queue: Queue;
  private worker: Worker | null = null;

  constructor(
    private readonly redisUrl: string,
    private readonly queueName = "chores",
  ) {
    this.queue = new Queue(this.queueName, {
      connection: new Redis(redisUrl, { maxRetriesPerRequest: null }),
    });
  }

  /** Idempotent: re-registering the same scheduler id updates, never duplicates. */
  async scheduleNightlyRetention(cron = "0 3 * * *"): Promise<void> {
    await this.queue.upsertJobScheduler(
      "retention-nightly",
      { pattern: cron },
      { name: "retention" },
    );
  }

  startConsumer(handlers: { retention: () => Promise<unknown> }): void {
    if (this.worker) throw new Error("chore consumer already started");
    this.worker = new Worker(
      this.queueName,
      async (job) => {
        if (job.name === "retention") await handlers.retention();
      },
      { connection: new Redis(this.redisUrl, { maxRetriesPerRequest: null }) },
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
