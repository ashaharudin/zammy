import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type { Kysely } from "kysely";
import {
  markDormantStorylines,
  pruneStoryDf,
  readLinkableGroups,
  pruneTermSnapshots,
  retentionReport,
  type Database,
  type RetentionReport,
} from "@zammy/storage";
import { storyDfDay } from "./story-df.js";
import { labelPass } from "./storyline-backfill.js";
import { labelLinkedStorylines, type LabelerDeps } from "./storyline-label-service.js";
import type { LabelMergeRules } from "./storyline-label-merge.js";
import {
  mergeAgreeingLabels,
  type LabelMergeReport,
} from "./storyline-label-merge-service.js";
import {
  linkGroup,
  runBridgeSweep,
  type BridgeSweepReport,
  type LinkOutcome,
  type LinkerConfig,
} from "./storyline-linker.js";

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
  log: {
    info: (obj: object, msg: string) => void;
    /** For per-item failures a tally line cannot carry — the err and its id. */
    warn: (obj: object, msg: string) => void;
  };
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
 * The nightly late-candidate sweep — the caller retroactive attachment never had
 * (ADR-0011: "a Wednesday storyline may pull in Monday's group"; the plan: "an
 * old group is just a candidate arriving late").
 *
 * The linker is offered every group exactly once, when it is born, and a
 * chronological backfill decides Monday's group before Wednesday's storyline
 * exists. So something has to OFFER old groups again, and the alternative —
 * waiting for the next full-archive replay — leaves the live system permanently
 * missing a behaviour two documents promise.
 *
 * Bounded by the trailing df window, which is the natural bound rather than an
 * arbitrary one: rarity is measured against that fortnight, so a group older than
 * the corpus that would judge it has no decision left to make here. Every offer
 * is idempotent (`linkGroup` re-derives rather than re-homes), which is what
 * makes running this every night cost reads and nothing else.
 *
 * Never throws for one group's sake, exactly as the linker and the backfill
 * don't: a group the sweep could not process is a group standing where it stood.
 */
export async function runLateCandidateChore(
  deps: ChoreDeps & {
    linker: LinkerConfig;
    /**
     * When present, what the sweep changed gets labelled the way the ingest
     * path labels what IT changed: a sweep merge relabels the winner, a
     * retroactive promotion names the newly-real storyline. Without this, the
     * identical merge keeps a stale label here and a fresh one on the live
     * path, for no reason a reader could see.
     */
    labeler?: Omit<LabelerDeps, "db">;
    /** Groups per read. Bounds memory, not correctness. */
    batchSize?: number;
    /** Hard ceiling on a night's offers, however wide the window is. */
    maxGroups?: number;
  },
): Promise<{ offered: number; attachedTo: number; merges: number; failures: number }> {
  const batchSize = deps.batchSize ?? 500;
  const maxGroups = deps.maxGroups ?? 20_000;
  const from = new Date(
    deps.now().getTime() - deps.config.storyDfWindowDays * 86_400_000,
  );

  const tally = { offered: 0, attachedTo: 0, merges: 0, failures: 0 };
  const changed: LinkOutcome[] = [];
  // The keyset `readLinkableGroups` pages on is `(group_published, group_id)`,
  // so the window's start IS a cursor: group id 0 is below every real id, which
  // makes the first read begin at the window rather than at the archive.
  // `publishedFrom` pushes the same bound INTO the aggregate, so each batch
  // scans the fortnight instead of GROUP BY-ing the whole archive.
  let after: { published: Date; groupId: string } = { published: from, groupId: "0" };

  for (;;) {
    const batch = await readLinkableGroups(deps.db, {
      after,
      publishedFrom: from,
      limit: batchSize,
    });
    if (batch.length === 0) break;

    for (const group of batch) {
      if (tally.offered >= maxGroups) break;
      tally.offered += 1;
      after = { published: group.published, groupId: group.groupId };
      try {
        const outcome = await linkGroup(
          { db: deps.db, config: deps.linker, log: deps.log },
          {
            groupId: group.groupId,
            memberTokens: group.memberTokens,
            language: group.language,
            published: group.published,
          },
        );
        tally.attachedTo += outcome.attachedTo.length;
        tally.merges += outcome.merged.length;
        if (outcome.attachedTo.length > 0 || outcome.merged.length > 0) {
          changed.push(outcome);
        }
      } catch (error) {
        // The tally line says how many; only this line can say WHICH and WHY.
        // A sweep that reports `failures: 18400` with no err is a regression
        // that persists for weeks.
        tally.failures += 1;
        deps.log.warn(
          { err: error, groupId: group.groupId },
          "late-candidate sweep: one group's offer failed; it stands where it stood",
        );
      }
    }

    if (tally.offered >= maxGroups || batch.length < batchSize) break;
  }

  // Label what the sweep changed — awaited, because 3am has no reader waiting
  // and never-throws is already labelLinkedStorylines' own contract. Only the
  // outcomes that changed something travel: most offers are no-ops and carry
  // no trigger anyway.
  if (deps.labeler && changed.length > 0) {
    await labelLinkedStorylines(
      { db: deps.db, labeler: deps.labeler, log: deps.log },
      changed,
    );
  }

  deps.log.info(
    { ...tally, from: from.toISOString(), windowDays: deps.config.storyDfWindowDays },
    "late-candidate sweep — retroactive attachment over the trailing window (ADR-0011)",
  );
  return tally;
}

/**
 * The nightly bridge sweep: merge every live pair already holding K independent
 * bridges (ADR-0011's repair, `runBridgeSweep`).
 *
 * The linker checks K when a bridge is inserted, which is the only moment it
 * sees; a MERGE re-points evidence onto the survivor and can lift a pair to K
 * with no insert at all. `cascadeMerge` closes that on the write path, and this
 * is the backstop — for whatever a crash left half-done, and for the archive
 * that accumulated misses before the cascade existed.
 *
 * Runs BEFORE the late-candidate sweep: a pair that should be one storyline
 * should be one storyline before old groups are offered to it, or the offer is
 * made against a profile that is about to change.
 */
export async function runBridgeSweepChore(
  deps: ChoreDeps & {
    linker: LinkerConfig;
    /**
     * Present, every survivor is re-named. Merge is one of ADR-0011's three
     * label triggers for a reason: an arc that absorbed three others is
     * described by a label made for a quarter of it, and the drift clock only
     * catches the ones whose membership happened to double.
     */
    labeler?: Omit<LabelerDeps, "db">;
  },
): Promise<BridgeSweepReport> {
  const report = await runBridgeSweep({
    db: deps.db,
    config: deps.linker,
    log: deps.log,
  });
  deps.log.info(
    { found: report.found, merged: report.merged, failures: report.failures,
      incomplete: report.incomplete, survivors: report.survivors.length,
      k: deps.linker.mergeBridges },
    "storyline bridge sweep — pairs at or above K, merged (ADR-0011)",
  );

  // Re-label off the same outcome shape the linker's own tail uses, so a sweep
  // merge and an ingest merge are named by one code path.
  if (deps.labeler && report.survivors.length > 0) {
    await labelLinkedStorylines(
      { db: deps.db, labeler: deps.labeler, log: deps.log },
      report.survivors.map((winnerId) => ({
        groupId: "",
        storylineId: winnerId,
        attached: false,
        attachedTo: [],
        promoted: [],
        bridged: [],
        merged: [{ winnerId, loserId: winnerId }],
      })),
    );
  }
  return report;
}

/**
 * The nightly label-agreement merge (`storyline-label-merge.ts`): storylines
 * that were independently given the same name by the model, and whose coverage
 * runs together, become one.
 *
 * Nightly rather than on the ingest path because the evidence only exists after
 * the fact. A label is written by the tail the linker starts and does not wait
 * for, so at the moment two arcs become mergeable neither of them is named yet;
 * asking on the write path would ask before the answer exists.
 *
 * It runs AFTER the label pass for the same reason, which is why the caller
 * orders it last: a storyline labelled tonight should be eligible tonight, not
 * tomorrow. That ordering is also what makes the pass converge — each night's
 * new labels are the next night's candidates.
 */
export async function runLabelMergeChore(
  deps: ChoreDeps & {
    rules: LabelMergeRules;
    /** Present, the survivor is re-named over its enlarged membership. */
    labeler?: Omit<LabelerDeps, "db">;
  },
): Promise<LabelMergeReport> {
  return mergeAgreeingLabels({
    db: deps.db,
    rules: deps.rules,
    timeZone: deps.config.timeZone,
    ...(deps.labeler ? { labeler: deps.labeler } : {}),
    log: deps.log,
  });
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
