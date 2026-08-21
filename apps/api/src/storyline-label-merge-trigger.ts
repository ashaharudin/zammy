import type { Kysely } from "kysely";
import {
  countStorylinesSharingLabelWords,
  readStoryline,
  type Database,
} from "@zammy/storage";
import { labelKey, type LabelMergeRules } from "./storyline-label-merge.js";
import { mergeAgreeingLabels } from "./storyline-label-merge-service.js";
import type { LabelerDeps, LabelOutcome } from "./storyline-label-service.js";

/**
 * The label-agreement merge, fired by the collision instead of by the clock.
 *
 * The nightly chore ordering (`chores.ts`) already states the fact this module
 * acts on: "at the moment two arcs become mergeable neither of them is named
 * yet", so the merge must run after labels are written. A LABEL WRITE is
 * therefore the exact moment a collision can come into being — and the ingest
 * tail is standing right there, holding the label it just wrote. Asking then
 * costs one indexed count; waiting for a scheduled pass costs however long the
 * schedule is, which on a host with no scheduler is forever (measured
 * 2026-08-21: one afternoon's backfill left six live arcs named "Canada US
 * Trade Talks" standing until an operator ran the CLI by hand).
 *
 * The DECISION is unchanged and lives where it always did: every scoped run
 * goes through `mergeAgreeingLabels`, so the grounding guard, the grace window
 * and the component valve apply identically whether the clock or the collision
 * asked. What this module owns is only when to ask, and it is built to be safe
 * to ask from an un-awaited tail:
 *
 *  - **Never throws.** It runs behind the same start-and-walk-away promise as
 *    the labelling it follows, where a rejection is a process-level event for
 *    a repair that has a nightly retry.
 *  - **Cheap when nothing collides**, which is almost always: one GIN-indexed
 *    count per label written, and the candidate/coverage reads only for a
 *    label the count says is shared.
 *  - **Concurrency-safe by inheritance.** Two tails firing on the same label
 *    both plan, `mergeStorylines` serializes them behind its advisory lock,
 *    and the loser's writes alias-resolve into no-ops.
 */

export interface CollisionMergeDeps {
  db: Kysely<Database>;
  rules: LabelMergeRules;
  timeZone: string;
  /**
   * Live storylines that must share a label before a scoped run fires —
   * `STORYLINE_LABEL_MERGE_TRIGGER`, where 0 is the off switch. The planner's
   * own bar is 2, so a higher value here only ever delays what the nightly
   * pass would merge anyway.
   */
  threshold: number;
  /** Present, a scoped run re-names its survivors, exactly as the chore does. */
  labeler?: Omit<LabelerDeps, "db">;
  log?: {
    info?: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
}

export interface CollisionMergeReport {
  /** Distinct label keys the batch wrote and the trigger counted. */
  checked: number;
  /** Keys whose count met the threshold — each one handed to a scoped run. */
  fired: number;
  merged: number;
  rounds: number;
}

/**
 * Backstop on the convergence loop below, not its normal exit. Each merging
 * round strictly shrinks the number of live storylines, so the loop terminates
 * without it; what it bounds is how much of that convergence one ingest batch
 * is allowed to pay for. The live archive's deepest observed chain is two
 * rounds (a survivor relabelled into an existing name, 2026-08-21), and a
 * batch that hits the cap leaves a collision the next label write — or the
 * nightly pass — picks up.
 */
const ROUND_LIMIT = 4;

/**
 * Count one label's live holders, at the key the planner buckets by. The key
 * IS the folded words sorted (`labelKey`), so splitting it back apart is the
 * one representation both the GIN pre-check and the planner agree on.
 */
async function collides(
  deps: Pick<CollisionMergeDeps, "db" | "threshold">,
  key: string,
): Promise<boolean> {
  const n = await countStorylinesSharingLabelWords(deps.db, key.split(" "));
  return n >= deps.threshold;
}

/**
 * Run the label-agreement merge for whatever the batch's label writes collided
 * with, then follow the survivors: a relabelled survivor can land on ANOTHER
 * live storyline's name, which is a fresh collision this same trigger must
 * answer or hand back to the schedule it exists to replace.
 */
export async function mergeCollidingLabels(
  deps: CollisionMergeDeps,
  labelled: readonly LabelOutcome[],
): Promise<CollisionMergeReport> {
  const report: CollisionMergeReport = { checked: 0, fired: 0, merged: 0, rounds: 0 };
  if (deps.threshold <= 0) return report;

  try {
    // Only a model label is merge evidence (the bigram fallback names
    // vocabulary), so only a model label can create the collision worth
    // counting — the same line `readLabelMergeCandidates` draws.
    const keys = new Set<string>();
    for (const outcome of labelled) {
      if (outcome.source !== "model" || outcome.label === null) continue;
      const key = labelKey(outcome.label);
      if (key.length > 0) keys.add(key);
    }

    let pending = new Set<string>();
    for (const key of keys) {
      report.checked += 1;
      if (await collides(deps, key)) pending.add(key);
    }

    while (pending.size > 0 && report.rounds < ROUND_LIMIT) {
      report.rounds += 1;
      report.fired += pending.size;
      const outcome = await mergeAgreeingLabels({
        db: deps.db,
        rules: deps.rules,
        timeZone: deps.timeZone,
        onlyLabelKeys: pending,
        ...(deps.labeler ? { labeler: deps.labeler } : {}),
        log: {
          info: (obj, msg) => deps.log?.info?.(obj, msg),
          warn: (obj, msg) => deps.log?.warn(obj, msg),
        },
      });
      report.merged += outcome.merged;
      if (outcome.merged === 0) break;

      // The survivors' names as they stand NOW — the relabel may have fallen
      // back or been skipped, and only what the row holds can collide.
      const next = new Set<string>();
      for (const survivor of outcome.survivors) {
        const row = await readStoryline(deps.db, survivor.winnerId);
        if (!row || row.mergedInto !== null || row.label === null) continue;
        if (row.labelSource === null || row.labelSource === "bigram") continue;
        const key = labelKey(row.label);
        if (key.length === 0) continue;
        if (await collides(deps, key)) next.add(key);
      }
      pending = next;
    }

    if (report.fired > 0) {
      deps.log?.info?.(
        { ...report, threshold: deps.threshold },
        "collision-triggered label merge — the nightly repair, run when the collision formed",
      );
    }
  } catch (error) {
    // The tail this runs in is started and dropped, so throwing is not an
    // option — and the nightly pass plans over everything this run would have.
    deps.log?.warn(
      { err: error },
      "collision-triggered label merge failed; the nightly pass is the retry",
    );
  }

  return report;
}
