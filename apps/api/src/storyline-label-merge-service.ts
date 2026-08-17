import type { Kysely } from "kysely";
import {
  mergeStorylines,
  readLabelMergeCandidates,
  readStoryline,
  readStorylineCoverageText,
  type Database,
} from "@zammy/storage";
import { singular } from "./grouping.js";
import { properNounEvidence } from "./headline-tokens.js";
import { labelStoryline, type LabelerDeps } from "./storyline-label-service.js";
import {
  labelWords,
  planLabelMerge,
  sharedLabels,
  type LabelMergeCandidate,
  type LabelMergePlan,
  type LabelMergeRefusal,
  type LabelMergeRules,
} from "./storyline-label-merge.js";

/**
 * The label-agreement merge, wired up: read the names, ask the coverage whether
 * they name anything, merge what agrees, and re-name the survivor.
 *
 * The decision is `storyline-label-merge.ts` and every rule lives there. What is
 * here is the corpus the grounding guard needs, the writes, and the discipline
 * that a pass over storylines has to have:
 *
 *  - **Two reads, not 258.** Candidates first (a small aggregate), then coverage
 *    text ONLY for labels more than one storyline holds. In the dev archive that
 *    is two components of 42 and 14 articles rather than every labelled arc.
 *  - **Grounding evidence per COMPONENT, from both sides' coverage.** A word is a
 *    name if the arcs that agreed on it never write it lowercase. Pooling the
 *    component is the point: one arc might never use a word in prose at all, and
 *    the question is about the story, not about one arc's writing style.
 *  - **Never throws for one component's sake**, the posture every storyline pass
 *    here takes. A component that fails leaves its arcs where they stood, and the
 *    next run tries again.
 *
 * Relabelling the survivor is not decoration. Merging is one of ADR-0011's three
 * label triggers precisely because the story changed shape, and the enlarged
 * membership is what should be named — the component agreed on a name, but it
 * agreed on it as several smaller stories.
 */

export interface LabelMergeDeps {
  db: Kysely<Database>;
  rules: LabelMergeRules;
  /**
   * When present the survivor is re-named. Absent — no `GEMINI_API_KEY`, or a
   * dry run — the merge still stands: a stale label on a correct storyline is
   * ADR-0011's own ordering, since the nightly drift pass repairs labels and
   * nothing keys off one.
   */
  labeler?: Omit<LabelerDeps, "db">;
  log?: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
}

export interface LabelMergeReport {
  /** Labels held by more than one live storyline — the whole candidate set. */
  sharedLabels: number;
  /** Components that qualified. */
  planned: number;
  /** Storylines that stopped existing as separate arcs. */
  merged: number;
  /** Components refused, with the reason — the operator's read on precision. */
  refusals: LabelMergeRefusal[];
  failures: number;
  /** Survivors, biggest component first — what to look at after a run. */
  survivors: { label: string; winnerId: string; absorbed: number }[];
}

/**
 * Plan the merges without writing anything.
 *
 * Exported so `--dry-run` and the chore share one planner: a dry run that
 * planned differently from the real thing would be worse than no dry run.
 */
export async function planLabelMerges(
  deps: Pick<LabelMergeDeps, "db" | "rules">,
): Promise<{ plans: LabelMergePlan[]; refusals: LabelMergeRefusal[]; sharedLabels: number }> {
  const rows = await readLabelMergeCandidates(deps.db);
  const candidates: LabelMergeCandidate[] = rows.map((row) => ({
    id: row.id,
    label: row.label,
    spanFromMs: row.spanFrom.getTime(),
    spanToMs: row.spanTo.getTime(),
    groupCount: row.groupCount,
  }));

  const components = sharedLabels(candidates);
  const plans: LabelMergePlan[] = [];
  const refusals: LabelMergeRefusal[] = [];

  for (const [label, arcs] of components) {
    const coverage = await readStorylineCoverageText(
      deps.db,
      arcs.map((arc) => arc.id),
    );
    // `properNounEvidence` answers for a SURFACE form by default; label words
    // arrive folded by `normalizeLabel`, whose fold is `singular`. So the corpus
    // side is folded the same way and the two meet on one spelling — unfolded,
    // "Hamas" would be recorded as `hamas` and asked for as `hama`, and every
    // name ending in `s` would be refused as no name at all.
    const evidence = properNounEvidence(coverage, singular);
    const isName = (word: string): boolean => evidence(word);

    const planned = planLabelMerge(label, arcs, isName, deps.rules);
    plans.push(...planned.plans);
    refusals.push(...planned.refusals);
  }

  return { plans, refusals, sharedLabels: components.size };
}

/**
 * Run the pass: plan, merge, relabel.
 *
 * `timeZone` reaches `mergeStorylines` because a merge recomputes the survivor's
 * day slots and a slot is a calendar day (§10.1).
 */
export async function mergeAgreeingLabels(
  deps: LabelMergeDeps & { timeZone: string },
): Promise<LabelMergeReport> {
  const { plans, refusals, sharedLabels: shared } = await planLabelMerges(deps);

  const report: LabelMergeReport = {
    sharedLabels: shared,
    planned: plans.length,
    merged: 0,
    refusals,
    failures: 0,
    survivors: [],
  };

  for (const plan of plans) {
    let absorbed = 0;
    let winnerId = plan.winnerId;
    try {
      for (const loserId of plan.loserIds) {
        // Alias-resolved inside, so a winner that has itself been merged away by
        // an earlier plan in this same pass still resolves to the survivor.
        const result = await mergeStorylines(deps.db, {
          winnerId,
          loserId,
          timeZone: deps.timeZone,
        });
        if (result.merged) {
          absorbed += 1;
          if (result.winnerId) winnerId = result.winnerId;
        }
      }
    } catch (error) {
      report.failures += 1;
      deps.log?.warn(
        { err: error, label: plan.label, winnerId: plan.winnerId },
        "label-agreement merge failed for one component; its arcs stand where they stood",
      );
      continue;
    }

    if (absorbed === 0) continue;
    report.merged += absorbed;
    report.survivors.push({ label: plan.label, winnerId, absorbed });

    // Re-name the survivor: the merge trigger, for the reason ADR-0011 gives it
    // one. Failing to relabel is not failing to merge — the label pass repairs
    // names nightly and a null or stale label renders.
    if (deps.labeler) {
      try {
        const storyline = await readStoryline(deps.db, winnerId);
        if (storyline && storyline.mergedInto === null) {
          await labelStoryline(
            { db: deps.db, ...deps.labeler },
            { storyline, trigger: "merge" },
          );
        }
      } catch (error) {
        deps.log?.warn(
          { err: error, storylineId: winnerId },
          "label-agreement merge: relabelling the survivor failed; the nightly pass will retry it",
        );
      }
    }
  }

  report.survivors.sort((a, b) => b.absorbed - a.absorbed);
  deps.log?.info(
    {
      sharedLabels: report.sharedLabels,
      planned: report.planned,
      merged: report.merged,
      refused: report.refusals.length,
      failures: report.failures,
      graceDays: deps.rules.graceDays,
    },
    "label-agreement merge — the name as merge evidence (ADR-0011's repair)",
  );
  for (const refusal of report.refusals) {
    // Every refusal by name, because a refusal is the precision guard reporting
    // a label worth reading. "Q2 2026 Financial Results" is the one the archive
    // supplies, and seeing it is how anyone knows the guard is load-bearing.
    deps.log?.info(
      { label: refusal.label, storylines: refusal.storylines, reason: refusal.reason },
      "label-agreement merge refused a component",
    );
  }

  return report;
}

/** The label words that carried a component, for a dry run's explanation. */
export function groundedWords(
  label: string,
  isName: (word: string) => boolean,
): string[] {
  return labelWords(label).filter((word) => isName(word));
}
