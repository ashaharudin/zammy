import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import {
  pruneStoryDf,
  pruneTermSnapshots,
  retentionReport,
  type Database,
  type RetentionReport,
} from "@zammy/storage";
import { storyDfDay } from "./story-df.js";

/**
 * Non-upstream chores (ARCHITECTURE 9.1): work with a clock but no quota
 * cost. The nightly retention REPORT (§7.5, ADR-0001), and with it the one
 * prune that DOES delete — `term_snapshots` past the baseline's reach.
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
  config: {
    retentionDays: number;
    baselineWindowDays: number;
    storyDfWindowDays: number;
    timeZone: string;
  };
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

  // The one exception to report-only, and it is not an exception to ADR-0001:
  // these rows are derived (§10.4) and worthless once the baseline can no
  // longer reach them. A day of slack past the window so a late chore run
  // cannot cut into the range the next refresh reads.
  const cutoff = new Date(
    deps.now().getTime() - (deps.config.baselineWindowDays + 1) * 86_400_000,
  );
  const prunedSnapshots = await pruneTermSnapshots(deps.db, { before: cutoff });
  deps.log.info(
    { prunedSnapshots, cutoff: cutoff.toISOString() },
    "pruned term_snapshots past the baseline window (§10.4)",
  );

  // Same argument, same slack, for the storyline linker's trailing corpus
  // (ADR-0011): day buckets the rolling window can no longer reach are
  // derived rows nothing will read again. The cutoff is a DAY KEY, so a
  // bucket leaves only once the whole local day is out of reach.
  const dfCutoff = storyDfDay(
    new Date(
      deps.now().getTime() - (deps.config.storyDfWindowDays + 1) * 86_400_000,
    ),
    { timeZone: deps.config.timeZone },
  );
  const prunedStoryDf = await pruneStoryDf(deps.db, { before: dfCutoff });
  deps.log.info(
    { prunedStoryDf, cutoff: dfCutoff },
    "pruned story_token_days past the trailing-corpus window (ADR-0011)",
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
