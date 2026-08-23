import type { Kysely } from "kysely";
import {
  clearStorylineLinkDirty,
  markDormantStorylines,
  markStorylinesLinkDirty,
  readLinkDirtyClock,
  pruneStoryDf,
  readLinkableGroups,
  retentionReport,
  type Database,
  type RetentionReport,
} from "@zammy/storage";
import { storyDfDay } from "./story-df.js";
import { labelPass } from "./storyline-backfill.js";
import { readChangedSetBatch } from "./storyline-changed-set.js";
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
 * `chores-cli.ts` under whatever the platform's scheduler is — a systemd timer,
 * a platform cron, a managed scheduler. There is no deployment target as of
 * 2026-08-21, so no scheduler is wired anywhere: whatever target comes next owes
 * these two passes one, and the requirement is that the pass runs, never the
 * mechanism. (DEPLOYMENT-OCI §1 described one; it is archival.)
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
     * Model calls per minute. Only the model is paced; the fallback is CPU.
     * Defaults to the free tier's ceiling; `GEMINI_MAX_RPM` is the knob, and
     * the server passes it through.
     */
    labelRatePerMinute?: number;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<{ model: number; bigram: number; none: number; skipped: number }> {
  const labelled = await labelPass(
    deps.db,
    deps.labeler,
    {
      maxLabels: deps.maxLabels ?? 500,
      labelRatePerMinute: deps.labelRatePerMinute ?? 15,
    },
    deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  );
  deps.log.info({ labelled }, "storyline label pass — the drift trigger (ADR-0011)");
  return labelled;
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
}

export interface StorylinePassReport {
  dormant: number;
  bridges: BridgeSweepReport;
  /** `skipped` marks a night the sweep was gated off, not a night it found nothing. */
  lateCandidates: Awaited<ReturnType<typeof runLateCandidateChore>> & { skipped?: true };
  labels: Awaited<ReturnType<typeof runStorylineLabelChore>>;
  labelMerge: LabelMergeReport;
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

  return { dormant, bridges, lateCandidates, labels, labelMerge };
}
