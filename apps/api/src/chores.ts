import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import {
  markDormantStorylines,
  pruneStoryDf,
  pruneTermSnapshots,
  retentionReport,
  type Database,
  type RetentionReport,
} from "@zammy/storage";
import { storyDfDay } from "./story-df.js";
import { labelPass } from "./storyline-backfill.js";
import type { LabelerDeps } from "./storyline-label-service.js";

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
    /** ADR-0011's ~90: days without coverage after which a storyline is quiet.
     * The same knob the linker's gate reads, so the column cannot disagree
     * with the bar. */
    storylineDormancyDays: number;
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

/**
 * The nightly dormancy sweep (ADR-0011, "Lifecycle"): make the status column say
 * what the linker already computes.
 *
 * The linker measures dormancy dynamically, from a candidate's last coverage,
 * and that is right for a linking decision — it must be true of the storyline at
 * the moment the question is asked. The COLUMN is the READ side's
 * representation of the same fact, and a nightly pass is enough for it: what
 * reads it is a pill in a search result, where "quiet since March" is the whole
 * message and a few hours of lag cannot change it.
 *
 * Reactivation is deliberately NOT here. A dormant storyline that takes a group
 * at noon must not stay marked until 3am, so the write path flips it back
 * (`attachGroup`, `mergeStorylines`) — this sweep only ever marks quiet.
 */
export async function runDormancyChore(deps: ChoreDeps): Promise<{ dormant: number }> {
  const before = new Date(
    deps.now().getTime() - deps.config.storylineDormancyDays * 86_400_000,
  );
  const dormant = await markDormantStorylines(deps.db, { before });
  deps.log.info(
    { dormant, before: before.toISOString(), dormancyDays: deps.config.storylineDormancyDays },
    "storyline dormancy sweep (ADR-0011)",
  );
  return { dormant };
}

/**
 * The nightly label pass — ADR-0011's DRIFT trigger, and the live tail's repair
 * crew (S4: "label generation fires at promotion, on merge, and on drift").
 *
 * Drift is not an event: nothing happens at the moment a storyline's membership
 * has doubled since it was named, so the only way to notice is to ask the rows.
 * A nightly pass over the promoted candidates is that question, and it doubles as
 * the repair for anything the live tail missed — a crash between the linker and
 * the labeler, a deploy, a run of 503s. `pnpm label:storylines` stays as the
 * manual override; this is the same pass on a schedule.
 *
 * Bounded on purpose. The pass is the one thing here that spends money per call,
 * so a night gets a ceiling and a per-minute spacing rather than "everything
 * that needs it, as fast as the API allows".
 */
export async function runStorylineLabelChore(
  deps: ChoreDeps & {
    labeler: Omit<LabelerDeps, "db">;
    /** Ceiling on storylines one night will relabel. */
    maxLabels?: number;
    /** Model calls per minute. Only the model is paced; the fallback is CPU. */
    labelRatePerMinute?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ model: number; bigram: number; none: number; skipped: number }> {
  const labelled = await labelPass(
    deps.db,
    deps.labeler,
    {
      maxLabels: deps.maxLabels ?? 500,
      labelRatePerMinute: deps.labelRatePerMinute ?? 60,
    },
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );
  deps.log.info({ labelled }, "storyline label pass — the drift trigger (ADR-0011)");
  return labelled;
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

  /** The storyline lifecycle pass: dormancy, and the labels that drifted. */
  async scheduleNightlyStorylines(cron = "0 4 * * *"): Promise<void> {
    await this.queue.upsertJobScheduler(
      "storylines-nightly",
      { pattern: cron },
      { name: "storylines" },
    );
  }

  startConsumer(handlers: {
    retention: () => Promise<unknown>;
    storylines?: () => Promise<unknown>;
  }): void {
    if (this.worker) throw new Error("chore consumer already started");
    this.worker = new Worker(
      this.queueName,
      async (job) => {
        if (job.name === "retention") await handlers.retention();
        if (job.name === "storylines") await handlers.storylines?.();
      },
      { connection: new Redis(this.redisUrl, { maxRetriesPerRequest: null }) },
    );
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}
