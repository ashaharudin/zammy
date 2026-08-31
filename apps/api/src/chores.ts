import type { Kysely } from "kysely";
import {
  clearStorylineLinkDirty,
  markDormantStorylines,
  markStorylinesLinkDirty,
  readLinkDirtyClock,
  pruneStoryDf,
  readLinkableGroups,
  readStorylineStats,
  reindexBloatedTables,
  retentionReport,
  type Database,
  type ReindexReport,
  type RetentionReport,
} from "@zammy/storage";
import { storyDfDay } from "./story-df.js";
import { labelPass, type LabelPassTally } from "./storyline-backfill.js";
import { readChangedSetBatch } from "./storyline-changed-set.js";
import { labelLinkedStorylines, type LabelerDeps } from "./storyline-label-service.js";
import {
  summaryPass,
  type SummarizerDeps,
  type SummaryPassTally,
} from "./storyline-summary-service.js";
import { summaryDayBounds, summaryDayKey } from "@zammy/storage";
import type { LabelMergeRules } from "./storyline-label-merge.js";
import {
  mergeAgreeingLabels,
  type LabelMergeReport,
} from "./storyline-label-merge-service.js";
import {
  linkGroup,
  runBridgeSweep,
  type BridgeSweepReport,
  type LinkableGroup,
  type LinkOutcome,
  type LinkerConfig,
} from "./storyline-linker.js";

/**
 * Non-upstream chores (ARCHITECTURE 9.1): work with a clock but no quota
 * cost. The nightly retention REPORT (§7.5, ADR-0001), and with it the prune
 * that DOES delete — `story_token_days` past the linker's trailing window.
 * (`term_snapshots` used to be pruned here too; the table went with the term
 * cloud, ADR-0013.)
 *
 * ── Where the schedule lives ─────────────────────────────────────────────────
 * Outside this process. These passes run as one-shot invocations of
 * `chores-cli.ts` under whatever the platform's scheduler is. Deployment moved
 * to Vercel + Supabase + Upstash (ADR-0015); Supabase Cron drives the schedule.
 *
 * They used to be a BullMQ job scheduler inside the api,
 * which bought exactly-once across N instances from Redis-shared state; the
 * runner now buys the same property from a Postgres advisory lock, and the
 * platform owns the clock.
 *
 * The trade is deliberate and it is not free: a scheduler the app registers at
 * boot cannot be forgotten, whereas an external one is absent until someone
 * configures it, and nothing in the app will say so. What the trade buys is a
 * process that exists only while the work does — the api no longer has to be
 * awake at 3am for the retention report to happen, which is the whole point.
 *
 * Note what these chores do NOT touch: Redis. Every pass here reads and writes
 * Postgres and (for labels) calls Gemini, so the runner needs no cache, no
 * queue, and no `REDIS_URL` that resolves to anything.
 */

/** §7.5: a topic hit within this window still protects its articles. */
const TOPIC_IDLE_DAYS = 30;

export interface ChoreDeps {
  db: Kysely<Database>;
  config: {
    retentionDays: number;
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
 * Everything the retention night does. The REPORT is the deliverable; the two
 * numbers under it are the only things the pass changes, and both are about
 * derived rows rather than about the corpus (ADR-0001).
 */
export interface RetentionChoreReport {
  retention: RetentionReport;
  /** Day buckets dropped past the linker's trailing window. */
  prunedStoryDf: number;
  /** The index-bloat sweep (VERCEL-ALL-IN-SCOPE §3.3). */
  reindex: ReindexReport;
}

/**
 * Run the report and put it in the structured log — that IS the deliverable.
 * Deletion is a later, deliberate decision (ADR-0001), so the numbers must be
 * visible long before any code acts on them.
 */
export async function runRetentionChore(deps: ChoreDeps): Promise<RetentionChoreReport> {
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
  // the storyline linker's trailing corpus is derived, and day buckets the
  // rolling window can no longer reach are rows nothing will read again
  // (ADR-0011). A day of slack past the window so a late chore run cannot cut
  // into the range the next link decision reads. The cutoff is a DAY KEY, so a
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

  // The index-bloat sweep, AFTER the prune and in the same pass, which is the
  // whole reason it lives here rather than on a schedule of its own: the prune
  // above is the largest single source of the dead index pages the sweep
  // reclaims (605,268 deletes against 84,550 live rows on `story_token_days`),
  // so reindexing before it would rebuild indexes the prune is about to churn.
  //
  // It is a STORAGE chore, not a performance one — 22% of the database on a
  // 500 MB budget, recovered in ~2 s of non-blocking work
  // (VERCEL-PHASE-0-FINDINGS §5). `reindexBloatedTables` never throws, so a
  // table that loses a lock race cannot cost us the report above.
  const reindex = await reindexBloatedTables(deps.db);
  deps.log.info(
    { reindex },
    "reindexed the churning tables — index bloat is storage, not latency (findings §5)",
  );
  if (reindex.invalidIndexes.length > 0) {
    // Nothing cleans these up and nothing else complains: an interrupted
    // CONCURRENTLY rebuild leaves a twin that is never read and still maintained
    // on every write, which is the exact opposite of what this sweep is for.
    deps.log.warn(
      { invalidIndexes: reindex.invalidIndexes },
      "invalid indexes standing after REINDEX CONCURRENTLY — drop them by hand",
    );
  }

  return { retention: report, prunedStoryDf, reindex };
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
 * ## Two modes, and what the narrow one stops promising
 *
 * `changedOnly` narrows the offer set to the groups whose ANSWER could have moved
 * since the markers were last cleared — the changed arcs' member groups, plus
 * whatever their inverse retrieval names (`storyline-changed-set.ts`). It is the
 * same decision on the same bar: the filter is a retrieval bound, and `linkGroup`
 * is still the only thing that decides.
 *
 * It is a **3.4× narrowing, not an order of magnitude**, and not the ~24× it was
 * designed for — a night of 250 changed arcs names 3,698 of the window's 12,558
 * groups. docs/STORYLINE-LINKING.md, "The nightly sweep's changed-set filter",
 * has why: the mass-and-anchor predicates that would have made it selective
 * cannot be evaluated here at all, because they are functions of which fortnight
 * the reader is standing in, and pushing them into SQL anyway reached 38.9% of
 * the pairs the forward decision qualified.
 *
 * What it gives up is the unfiltered pass's one-line guarantee — "every group in
 * the window, every night" — and the classes it stops reaching are real:
 * trailing-corpus drift under a group and an arc that neither changed (last
 * night's retention prune moves the verdict with no storyline anywhere in the
 * causal chain), and a group holding no storyline at all, which has no marker to
 * carry it here. docs/ARCHITECTURE.md §9.1 has the full list. Those want an
 * unfiltered pass on some cadence, which is why this is a knob and not a
 * replacement, and why `STORYLINE_LATE_CANDIDATE_CHANGED_ONLY` ships off.
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
    /**
     * Offer only the groups whose candidate set could have changed since the
     * markers were last cleared, instead of the whole window
     * (`storyline-changed-set.ts`). See this function's doc comment for what the
     * narrow mode stops promising, and docs/ARCHITECTURE.md §9.1 for the list.
     */
    changedOnly?: boolean;
  },
): Promise<{
  offered: number;
  attachedTo: number;
  merges: number;
  failures: number;
  /** Changed arcs consumed. Zero in the unfiltered mode, which reads no markers. */
  changedArcs: number;
}> {
  const batchSize = deps.batchSize ?? 500;
  const maxGroups = deps.maxGroups ?? 20_000;
  const from = new Date(
    deps.now().getTime() - deps.config.storyDfWindowDays * 86_400_000,
  );

  const tally = { offered: 0, attachedTo: 0, merges: 0, failures: 0, changedArcs: 0 };
  const changed: LinkOutcome[] = [];

  /**
   * One group's offer. Shared by both modes on purpose: the filter decides WHICH
   * groups are asked and nothing else, so a second copy of this loop would be a
   * second set of rules about what an offer means.
   */
  const offer = async (group: LinkableGroup): Promise<void> => {
    tally.offered += 1;
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
      // A withheld formation travels too: its attachedTo and merged are both
      // empty — the merge is the thing being withheld — and dropping it here
      // would leave labelLinkedStorylines' resolvePendingFormations as the
      // retry this sweep is supposed to be. The pair would be re-withheld and
      // re-dropped every night, forever.
      if (
        outcome.attachedTo.length > 0 ||
        outcome.merged.length > 0 ||
        outcome.pendingFormation !== undefined
      ) {
        changed.push(outcome);
      }
      // And a withheld formation must keep TRAVELLING, which in the filtered
      // mode is a second obligation: a withhold writes nothing at all — both
      // groups keep their own storylines and the only carrier is the in-memory
      // outcome — so nothing marked anything, and the clear below would drop the
      // pair out of the changed set for good. Re-marking the group's own arc puts
      // it back: next pass offers this group again, re-derives the same withhold,
      // and the loop is exactly the one the unfiltered sweep has always run.
      if (outcome.pendingFormation !== undefined) {
        await markStorylinesLinkDirty(deps.db, [
          outcome.storylineId,
          outcome.pendingFormation.winnerId,
        ]);
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
  };

  if (deps.changedOnly) {
    let after: { dirtyAt: Date; id: string } | undefined;
    /**
     * Groups this pass has already offered.
     *
     * The changed set is deduped WITHIN a batch of arcs, and that is not enough:
     * a group named by an arc in batch one and again by an arc in batch four is
     * two offers of the same question against a database that has not changed in
     * between. MEASURED, and it is not marginal — a filtered pass over the dev
     * archive offered 20,000 times against a window of 12,558 groups, so most of
     * the excess was the same groups over again. Bounded by the window, so at
     * most ~12k ids.
     */
    const offeredIds = new Set<string>();
    // The queue as it stands NOW. Everything this pass marks — and it marks
    // plenty, since an attach or a merge is exactly what the marker records —
    // lands after this and waits for the next run. Without the bound one pass
    // follows its own cascade to convergence, which is not a nightly pass.
    //
    // The DATABASE's clock, not `deps.now()`: the markers are stamped server-side
    // and comparing them against an app clock is comparing two clocks. The chore
    // clock is injectable, so in a test the two are not even the same year.
    const markedBefore = await readLinkDirtyClock(deps.db);
    for (;;) {
      const batch = await readChangedSetBatch(
        { db: deps.db, config: deps.linker, log: deps.log },
        { publishedFrom: from, markedBefore, limit: batchSize, ...(after ? { after } : {}) },
      );
      tally.changedArcs += batch.markers.length;

      let cutShort = false;
      if (batch.groupIds.length > 0) {
        // Publication order, so a replay of one pass reaches the same
        // assignments (§7.4) — `onlyGroupIds` returns them ordered, which is the
        // same order `linkSeededGroups` sorts a batch into.
        const groups = await readLinkableGroups(deps.db, {
          onlyGroupIds: batch.groupIds,
          limit: batch.groupIds.length,
        });
        for (const group of groups) {
          if (tally.offered >= maxGroups) {
            cutShort = true;
            break;
          }
          // The window bound, which `onlyGroupIds` deliberately does not apply —
          // it ignores the keyset entirely, by design, for the resume case. A
          // changed arc's member groups can be older than the trailing corpus
          // that would judge them, and the unfiltered pass does not offer those:
          // rarity is measured against the fortnight, so a group older than it
          // has no decision left to make. MEASURED, and not a rounding error —
          // with every arc marked, unbounded member groups name 26,006 groups
          // against the window's 12,558.
          if (group.published < from) continue;
          if (offeredIds.has(group.groupId)) continue;
          offeredIds.add(group.groupId);
          await offer(group);
        }
      }

      // Cleared AFTER the offers, and only for markers no newer than the ones
      // read: an attach or merge one of these offers just performed has moved
      // the marker forward, and that arc is a genuinely new question for the
      // next pass rather than one this pass already answered.
      //
      // And NOT AT ALL when `maxGroups` cut the batch short. The markers are
      // per-arc but the offers are the union over the batch, so there is no
      // telling which arc an un-offered group came from — clearing here would
      // retire questions this pass never asked, and the tally would still read
      // clean. Leaving the whole batch marked costs a repeat next pass, which is
      // idempotent; the alternative loses offers silently, which is the one
      // failure mode a changed-set filter must not have.
      if (!cutShort) await clearStorylineLinkDirty(deps.db, batch.markers);

      if (batch.next === null || tally.offered >= maxGroups) break;
      after = batch.next;
    }
  } else {
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
        after = { published: group.published, groupId: group.groupId };
        await offer(group);
      }

      if (tally.offered >= maxGroups || batch.length < batchSize) break;
    }
  }

  // Label what the sweep changed — awaited, because 3am has no reader waiting
  // and never-throws is already labelLinkedStorylines' own contract. Only the
  // outcomes that changed something — or withheld a formation — travel: most
  // offers are no-ops and carry no trigger anyway.
  if (deps.labeler && changed.length > 0) {
    await labelLinkedStorylines(
      {
        db: deps.db,
        labeler: deps.labeler,
        log: deps.log,
        formations: { timeZone: deps.config.timeZone },
      },
      changed,
    );
  }

  deps.log.info(
    {
      ...tally,
      changedOnly: deps.changedOnly === true,
      from: from.toISOString(),
      windowDays: deps.config.storyDfWindowDays,
    },
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
 * Nightly AND on the ingest path, and the two runs answer different misses. The
 * evidence only exists after the fact — a label is written by the tail the
 * linker starts and does not wait for, so at the moment two arcs become
 * mergeable neither of them is named yet. The ingest tail therefore asks again
 * the moment it writes a label (`storyline-label-merge-trigger.ts`, scoped to
 * that one label); this pass is the unscoped backstop for whatever the trigger
 * missed — a crashed tail, a disabled trigger, a collision assembled by drift
 * relabels that never went through the tail at all.
 *
 * It runs AFTER the label pass for that same after-the-fact reason, which is
 * why the caller orders it last: a storyline labelled tonight should be
 * eligible tonight, not tomorrow. That ordering is also what makes the pass
 * converge — each night's new labels are the next night's candidates.
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
    /**
     * Wall-clock ceiling for the pass. Absent is unbounded — right for a CLI
     * run, wrong for the route, which lives inside a function timeout. See
     * `BackfillOptions.labelBudgetMs` for what being killed costs.
     */
    labelBudgetMs?: number;
    /**
     * Model calls per minute. Only the model is paced; the fallback is CPU.
     * Defaults to the free tier's ceiling; `GEMINI_MAX_RPM` is the knob, and
     * the server passes it through.
     */
    labelRatePerMinute?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<LabelPassTally> {
  const labelled = await labelPass(
    deps.db,
    deps.labeler,
    {
      maxLabels: deps.maxLabels ?? 500,
      labelRatePerMinute: deps.labelRatePerMinute ?? 30,
      ...(deps.labelBudgetMs !== undefined ? { labelBudgetMs: deps.labelBudgetMs } : {}),
      // The clock the budget measures elapsed time against — `ChoreDeps.now`,
      // which is the real one everywhere but a test.
      now: deps.now,
    },
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );
  deps.log.info(
    { labelled },
    labelled.stoppedBy === "exhausted"
      ? "storyline label pass — the drift trigger (ADR-0011)"
      : // Its own message, because the difference between "there was nothing to
        // do" and "we ran out of room" is the whole reading of the line, and a
        // field buried in an object that is identical either way is not how a
        // truncation gets noticed.
        `storyline label pass stopped early (${labelled.stoppedBy}) — ` +
        "the rest is deferred to the next pass, which reselects it",
  );
  return labelled;
}

/**
 * The graph's shape at the end of the night — ADR-0011's percolation alarm,
 * finally somewhere a series of nights can be read off it.
 *
 * Flat and numeric on purpose. The home this wants is the `chore_runs` row
 * Phase 4 adds (VERCEL-PHASE-0-FINDINGS §2.7, action 3; `/metrics` is gone,
 * §7), and until that table exists the structured log is the whole deliverable
 * — same argument as `runRetentionChore`. Every field here is one column when
 * it moves, with the same meaning it has here, so the move is a copy and not a
 * redefinition.
 */
export interface StorylineGraphReport {
  /** Live storylines. The denominator for everything below. */
  arcs: number;
  /** Arcs holding more than one group — the ones that are REAL (ADR-0011). */
  promoted: number;
  /** Groups in the biggest arc. THE alarm; the rest of this exists to read it. */
  largestArc: number;
  /** Groups the linker has reached — what `largestArc` is a share OF. */
  linkedGroups: number;
  singletons: number;
  arcs2To4: number;
  arcs5To19: number;
  arcs20To99: number;
  arcs100Plus: number;
  /** Standing rows in `storyline_bridges`: K of these merge a pair. */
  bridges: number;
}

/**
 * Put the graph's shape on the nightly report.
 *
 * ## Why this exists at all
 *
 * `readStorylineStats` has computed the percolation alarm since the backfill
 * needed it, and its own comment calls the largest-arc number "ADR-0009's
 * 1,179-group swallow expressed as a number that can be watched". Nothing was
 * watching it: it was printed after a manual backfill and during a manual
 * measurement run, and the nightly pass reported `dormant`, `bridges`,
 * `lateCandidates`, `labels` and `labelMerge` — no graph shape at all. So the
 * late-candidate runaway (VERCEL-PHASE-0-FINDINGS §2.6) had to be discovered by
 * a human running a harness by hand, which took four sessions and two wrong
 * projections. This is §2.7's action 3, the one that needed no measurement and
 * no decision first.
 *
 * It reuses `readStorylineStats` rather than asking its own question, because a
 * second definition of "largest arc" is how the nightly number and the
 * document's number quietly stop being the same number.
 *
 * ## Why the distribution and not just the maximum
 *
 * §2.6's transferable lesson: the largest arc held at **124 for four bounded
 * passes** while the population underneath it was collapsing, and per-offer cost
 * IMPROVED as the graph degraded. A single metric can look calm through a
 * failure. The buckets are what tell a swallow (top bucket grows, middle thins)
 * from a suppressed backlog draining correctly (middle thickens, top still 1) —
 * which is precisely the reading docs/STORYLINE-LINKING.md's "Graph shape"
 * table makes, on these same bucket edges.
 *
 * ## Why there is no merges-per-night count
 *
 * §2.7 asked for three numbers and this reports two of them. Merges on the
 * BIRTH path are recorded nowhere — `mergeStorylines` writes no merge event and
 * the schema has no merge timestamp, only `storylines.merged_into`, which says
 * a merge happened once and never when — so a per-night count is a schema
 * change, not a field. It is a real gap and it is deliberately not filled here.
 *
 * What makes that acceptable is that **the series is the alarm**. Percolation is
 * a trend, not an event: arc count falling while `largestArc` climbs and the
 * buckets shift upward IS the merge rate, observed at the only place it has a
 * consequence. A merge counter would be a nicer instrument, not a necessary
 * one, and the counter is not missing because anyone forgot.
 *
 * ## Why it does not warn, only records
 *
 * Deliberate, and the reasoning is worth keeping because "add a threshold" is
 * the obvious next thought. The three reference points that exist:
 *
 *   - **50** — the largest arc the replay harness builds at the pinned bar
 *     (share 0.002, mass 20). The steady state of a *correctly built* archive.
 *   - **1,347** — §2.6's runaway, ~11% of the window in one arc.
 *   - **1,179** — ADR-0009's swallow, which was 1,179 of a **single day's**
 *     1,190 groups: a 99% share of a day, not an archive-wide count.
 *
 * None of them yields a line. The 1,179 cannot: reused as an archive-wide
 * count it would silently mean something different from what it measured, and
 * as a share it is 99% — a threshold that fires only once the graph is already
 * destroyed. And the two that ARE archive-wide bracket a range nothing has
 * measured: production sits at 124 today because it was built under the
 * candidate cap, §2.7 says it should drift as the hybrid converges, and whether
 * it converges DOWN toward 50 or up is the unmeasured question that section
 * exists to pose. Any number between 124 and 1,347 would be picked by feel, and
 * this codebase does not ship tuned constants it cannot justify.
 *
 * So: record, and let the series be the alarm — which is the thing that has
 * been missing, not the threshold. Once a fortnight of these rows exists,
 * *then* a threshold can come off the data instead of out of the air.
 */
export async function runStorylineGraphChore(deps: ChoreDeps): Promise<StorylineGraphReport> {
  const stats = await readStorylineStats(deps.db);
  const graph: StorylineGraphReport = {
    arcs: stats.storylines,
    promoted: stats.promoted,
    largestArc: stats.largestStoryline,
    linkedGroups: stats.linkedGroups,
    singletons: stats.singletons,
    arcs2To4: stats.arcs2To4,
    arcs5To19: stats.arcs5To19,
    arcs20To99: stats.arcs20To99,
    arcs100Plus: stats.arcs100Plus,
    bridges: stats.bridges,
  };
  // Its own log line, not a corner of the pass's summary object: a log pipeline
  // grepping one message per night is what turns this into the series above.
  deps.log.info(
    { graph },
    "storyline graph shape — ADR-0011's percolation alarm (no threshold set)",
  );
  return graph;
}

/**
 * The nightly summary pass — the historical preserve (ADR-0022,
 * docs/STORYLINE-SUMMARIES.md).
 *
 * Its own pass on its own schedule (`0 5 * * *`), not a step of the storyline
 * night, and the separation is the decision rather than an accident of where the
 * code landed. The 04:00 pass is already the expensive one — 52.6 s on the last
 * verified full run, and it is the pass that has been killed at `maxDuration`
 * before — and it spends the same key. Stacking a hundred prose calls onto it
 * would turn one slow night into one that loses its `chore_runs` row and starves
 * live labelling at the same time.
 *
 * ## The window
 *
 * `SUMMARY_WINDOW_DAYS` back from the START of today's UTC day, so a pass firing
 * at 05:00 covers the whole of yesterday and not the 19 hours of it that fall
 * inside a rolling 24. Everything older than the window is the backfill CLI's
 * business — deliberately, because past the pubDate cliff a day can only honestly
 * carry one sentence and that is a decision an operator makes, not a thing that
 * happens at 5am.
 *
 * ## Two things it says out loud
 *
 * A pass that is switched off logs and returns rather than being absent, for the
 * reason the late-candidate sweep's skipped tally exists: "it ran and wrote
 * nothing" and "it never ran" are different facts.
 *
 * And a non-UTC `APP_TIMEZONE` is a warning here rather than a config refusal.
 * The summaries are keyed on UTC days unconditionally, so they stay internally
 * consistent whatever the app's timezone is — what changes is that this table's
 * `day_key` and `storyline_days.day_key` stop naming the same 24 hours, which is
 * a surprise for whoever joins them later and not an error today.
 */
export async function runSummaryChore(
  deps: StorylinePassDeps & { sleep?: (ms: number) => Promise<void> },
): Promise<SummaryPassTally & { enabled: boolean }> {
  if (deps.summariesEnabled !== true) {
    deps.log.info(
      {},
      "summary pass is off (SUMMARIES_ENABLED=false) — nothing written (ADR-0022)",
    );
    return {
      enabled: false,
      days: 0,
      written: 0,
      recomputed: 0,
      refused: 0,
      unavailable: 0,
      skipped: 0,
      model: 0,
      failures: 0,
      stoppedBy: "exhausted",
    };
  }

  if (deps.config.timeZone !== "UTC") {
    deps.log.warn(
      { appTimezone: deps.config.timeZone },
      "summaries are keyed on UTC days regardless of APP_TIMEZONE, so their day_key " +
        "no longer names the same 24 hours as storyline_days.day_key",
    );
  }

  const now = deps.now();
  // The window is whole UTC days, both ends, and neither end is `now`.
  //
  // The START, because a rolling 24 hours would cut yesterday off at 05:00 and
  // leave its last five hours unsummarised for ever once the day froze.
  //
  // The END, because the pass fires at 05:00 — INSIDE the night quarter of the
  // day it would otherwise include. Summarising today would write a `night`
  // sentence over 00:00-05:00 and then freeze it: tomorrow's recompute needs
  // more than `SUMMARY_RECOMPUTE_DELTA` new articles in the one remaining hour,
  // which essentially never happens, so every night quarter would permanently
  // describe five sixths of its span. A day is summarised once it has finished.
  const todayStart = summaryDayBounds(summaryDayKey(now)).from;
  const from = new Date(
    todayStart.getTime() - deps.summaryGate.windowDays * 86_400_000,
  );

  const tally = await summaryPass(
    // The pass's clock governs BOTH halves. `createSummarizer` leaves `now`
    // unset, so without this the window arithmetic here would read the chore's
    // clock while the age-and-cliff arithmetic inside read the wall clock —
    // identical in production, and a seam a frozen test clock falls straight
    // through.
    { db: deps.db, ...deps.summarizer, now: deps.now },
    {
      from,
      to: todayStart,
      minArticlesExclusive: deps.summaryGate.minArticlesExclusive,
      minGroups: deps.summaryGate.minGroups,
      now: deps.now,
      ...(deps.maxSummaries !== undefined ? { maxSummaries: deps.maxSummaries } : {}),
      ...(deps.summaryBudgetMs !== undefined ? { budgetMs: deps.summaryBudgetMs } : {}),
      ...(deps.summaryRatePerMinute !== undefined
        ? { ratePerMinute: deps.summaryRatePerMinute }
        : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    },
  );

  deps.log.info(
    { ...tally, from: from.toISOString(), windowDays: deps.summaryGate.windowDays },
    tally.stoppedBy === "exhausted"
      ? "storyline summary pass — the historical preserve (ADR-0022)"
      : // Its own message for the same reason the label pass has one: the
        // difference between "there was nothing to do" and "we ran out of room"
        // is the whole reading of the line.
        `storyline summary pass stopped early (${tally.stoppedBy}) — ` +
        "the rest is deferred to the next pass, which reselects it",
  );
  return { enabled: true, ...tally };
}

export interface StorylinePassDeps extends ChoreDeps {
  /** The bar the live write path judges at — see `wiring.createLinkerConfig`. */
  linker: LinkerConfig;
  /**
   * Required here, unlike on the individual chores: with no `GEMINI_API_KEY` the
   * labeler still exists and only its `generator` is null (the bigram extractor
   * becomes the whole path, ADR-0011). "No labeler at all" is not a state this
   * pass can be in, and the label pass has no meaningful behaviour without one.
   */
  labeler: Omit<LabelerDeps, "db">;
  rules: LabelMergeRules;
  /** Model calls per minute for the label pass. `--label-rate` on the runner. */
  labelRatePerMinute?: number;
  /** Ceiling on storylines one night will relabel. */
  maxLabels?: number;
  /** Wall-clock ceiling for the label pass — `CHORE_LABEL_BUDGET_MS`. */
  labelBudgetMs?: number;
  /**
   * Run the late-candidate sweep as part of the night. False skips step 3.
   *
   * It exists because of what fixing candidate retrieval revealed. The sweep
   * re-offers old groups, and until the retrieval was narrowed to the
   * anchor-eligible subset it was re-offering them against a candidate set
   * truncated to 200 rows by `last_coverage` — so the merges its bridges could
   * accumulate were bounded by an accident. Given the true candidate set, four
   * passes over 2,000 groups on a clone of the dev archive drove the largest
   * storyline from 124 groups to **201**, built four storylines over 100 groups
   * where there had been one, and the 201 is not a story: it chains Gaza, the
   * Israel-Iran war and Russia-Ukraine through shared diplomatic vocabulary.
   *
   * That is percolation, and it is NOT what the thresholds certify. The replay
   * harness at the pinned bar (share 0.002, mass 20) builds a largest storyline
   * of **50** groups. The replay cannot see the difference because it models
   * only birth-time offers — each group attaches once — while the sweep offers
   * the same group every night and `bridgePairs` records the full cross-product
   * of its qualifiers each time. Bridges went 1,913 → 10,282 on 2,000 groups.
   *
   * So the retrieval fix is unconditional — it makes the BIRTH path match the
   * replay that certified it, which is strictly a repair — and this pass is
   * off by default, because it is the path the replay never modelled. Turning it
   * on wants K (`STORYLINE_MERGE_BRIDGES`) re-measured against a replay that
   * re-offers, which does not exist yet. Until then the sweep is an operator
   * command run against a clone, not a thing that happens at 3am unattended.
   */
  lateCandidateSweep?: boolean;
  /**
   * Narrow the late-candidate sweep to the changed set
   * (`STORYLINE_LATE_CANDIDATE_CHANGED_ONLY`, `--changed-only` / `--full`).
   * Absent is the unfiltered pass, which is what this has always done.
   *
   * Only consulted when `lateCandidateSweep` is on — filtering a pass that does
   * not run is not a state worth having two ways to spell.
   */
  lateCandidatesChangedOnly?: boolean;
  /**
   * The summariser (ADR-0022). Required for the same reason `labeler` is: with
   * no key the object still exists and only its `generator` is null, and "no
   * summariser at all" is not a state the pass can be in.
   */
  summarizer: Omit<SummarizerDeps, "db">;
  /** `SUMMARIES_ENABLED`. Off, the pass runs and writes nothing, loudly. */
  summariesEnabled?: boolean;
  /** Which storyline-days one pass looks at, and the bar they must clear. */
  summaryGate: {
    windowDays: number;
    minArticlesExclusive: number;
    minGroups: number;
  };
  /** Ceiling on MODEL CALLS one summary pass may spend — `--max-summaries`. */
  maxSummaries?: number;
  /** Wall-clock ceiling for the summary pass — `SUMMARY_BUDGET_MS`. */
  summaryBudgetMs?: number;
  /** Model calls per minute for the summary pass — `--summary-rate`. */
  summaryRatePerMinute?: number;
}

export interface StorylinePassReport {
  dormant: number;
  bridges: BridgeSweepReport;
  /** `skipped` marks a night the sweep was gated off, not a night it found nothing. */
  lateCandidates: Awaited<ReturnType<typeof runLateCandidateChore>> & { skipped?: true };
  labels: Awaited<ReturnType<typeof runStorylineLabelChore>>;
  labelMerge: LabelMergeReport;
  /**
   * The shape the night ended in. Note `graph.bridges` is the STANDING count of
   * bridge evidence, where `bridges` above is what tonight's sweep found — a
   * total and a delta, not two spellings of one number.
   */
  graph: StorylineGraphReport;
}

/**
 * The storyline lifecycle pass: everything the night does to `storylines`, in
 * the one order that makes it converge.
 *
 * The order is mostly the order of what each pass READS. Steps 2–5 are
 * load-bearing in that sense; step 1 is the exception, and it is written out
 * because the obvious reason for it is wrong and reads as true:
 *
 *   1. **Dormancy** first — but NOT so the late sweep judges at the bar tonight's
 *      quiet earns. It could not: the linking decision never reads
 *      `storylines.status`. `barFor` re-derives dormancy from the candidate's
 *      last coverage on every call, and `LinkCandidate` carries no status at
 *      all, so nothing this pass writes to that column can move the sweep's
 *      threshold. What DOES read it here is `mergeStorylines`, which asks
 *      whether the LOSER was dormant before deciding to wake the winner —
 *      stamping first is what makes that question about the storyline's silence
 *      today rather than about yesterday's column. That is the whole of it. The
 *      stamp is derived from the day slots and idempotent, so the column itself
 *      converges wherever in the night it runs; the backfill deliberately puts
 *      its own stamp LAST, and the one case this order is worse at is a
 *      storyline the sweep below promotes tonight whose coverage is already
 *      months old — it reads `active` until tomorrow's stamp.
 *   2. **The bridge sweep** before the late-candidate sweep: a pair that should
 *      be one storyline should be one BEFORE old groups are offered to it, or
 *      the offer is made against a profile that is about to change.
 *   3. **The late-candidate sweep**, so the storylines it grows are the ones the
 *      label pass then looks at — a membership change and its label in one
 *      night, rather than a label describing yesterday's membership. OFF by
 *      default since candidate retrieval was fixed: see `lateCandidateSweep`
 *      for the 124→201-group percolation that measured its way into being a
 *      flag. When it is off, steps 1, 2, 4 and 5 still run — dormancy and the
 *      bridge sweep are not its dependents, they are its inputs.
 *   4. **The label pass** (the drift trigger).
 *   5. **The label-agreement merge** LAST, because it is the only pass whose
 *      input is a label: a storyline named tonight should be a merge candidate
 *      tonight rather than tomorrow (ADR-0011's repair). This is also what makes
 *      the whole thing converge — each night's new labels are the next night's
 *      candidates.
 *
 * Sequential on purpose, and awaited: 3am has no reader waiting, and from step 2
 * down every step's input is something the previous step just changed.
 */
export async function runStorylinePass(
  deps: StorylinePassDeps,
): Promise<StorylinePassReport> {
  const { dormant } = await runDormancyChore(deps);
  const bridges = await runBridgeSweepChore(deps);
  // A skipped sweep reports a zero tally rather than being absent from the
  // report: "it ran and changed nothing" and "it did not run" are different
  // facts, and a report that cannot tell them apart is how a flag left off by
  // accident survives a month of clean-looking nightly logs.
  const lateCandidates =
    deps.lateCandidateSweep === true
      ? await runLateCandidateChore({
          ...deps,
          ...(deps.lateCandidatesChangedOnly !== undefined
            ? { changedOnly: deps.lateCandidatesChangedOnly }
            : {}),
        })
      : {
          // Every field the real tally carries, so a skipped night is the same
          // SHAPE as a run that changed nothing and only `skipped` tells them
          // apart. `changedArcs` arrived with the changed-set filter; a zero
          // here is honest either way, since a pass that did not run marked
          // nothing.
          offered: 0,
          attachedTo: 0,
          merges: 0,
          failures: 0,
          changedArcs: 0,
          skipped: true as const,
        };
  const labels = await runStorylineLabelChore(deps);
  const labelMerge = await runLabelMergeChore(deps);
  // 6. Read the graph's shape LAST, so the row describes the archive the night
  //    leaves behind rather than the one it found. It changes nothing, which is
  //    why it can sit outside the ordering argument above — and it is one round
  //    trip, 16-21 ms measured on 27,083 `storyline_groups` rows, against a
  //    300-second function ceiling (VERCEL-ALL-IN-SCOPE §3.3). It is CHEAPER
  //    than the stats read was before the distribution was added; see
  //    `readStorylineStats`.
  const graph = await runStorylineGraphChore(deps);

  return { dormant, bridges, lateCandidates, labels, labelMerge, graph };
}
