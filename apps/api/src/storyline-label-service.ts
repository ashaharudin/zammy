import type { Kysely } from "kysely";
import type { Database } from "@zammy/storage";
import type { LabelTrigger } from "./storyline-label.js";
import { nameStoryline, type LabelerDeps, type LabelOutcome } from "./storyline-naming.js";
import type { LinkOutcome } from "./storyline-linker.js";
import { resolvePendingFormations, type FormationDeps } from "./storyline-formation.js";

/**
 * WHEN a storyline is named — the live tail, and nothing else (ADR-0011).
 *
 * What a name is and how it is written moved to `storyline-naming.ts`, which is
 * the one writer of the label columns. What is left here is the other half of
 * the design: which of a batch's link outcomes deserve a name, under which
 * trigger, and how much a batch is allowed to spend finding out.
 *
 * All three of ADR-0011's moments have a caller. `promotion` and `merge` are
 * events the caller has just written, and they arrive through
 * `labelLinkedStorylines` below — the tail the ingest path starts and does not
 * wait for. `drift` is a question asked of the row rather than an event, so it
 * belongs to a pass over candidates: the nightly chore, and the operator's
 * `pnpm label:storylines`.
 */

/**
 * Label what a batch of link outcomes just made real (ADR-0011: "fires at
 * promotion, on merge, and on drift" — the first two).
 *
 * Deliberately OFF the latency path. The linker runs inside the §6.3 sync-fill
 * deadline and a label averages ~8s against a 20s timeout, so the ingest hands
 * this the outcomes and walks away: the caller starts it and does not await it.
 * That is only safe because it never throws — a rejected promise nobody awaits
 * is an unhandled rejection, which is a process-level event for a cosmetic
 * failure. Every model failure is already the labeler's own business (it falls
 * back), and anything else is logged here and dropped.
 *
 * One label per storyline per batch, strongest trigger winning (merge >
 * promotion > drift): a group that promoted a storyline and then merged it into
 * another has made the wider membership the thing to name, and asking twice
 * would spend two calls to write the second answer.
 *
 * The trigger is what bounds the spend, so it must be honest about what
 * happened. Only `outcome.promoted` — a provisional actually made real — fires
 * the unconditional promotion label. A join to an ESTABLISHED arc (`attached`
 * on the 30th group as much as the 3rd) and a retroactive attach fire `drift`,
 * which `needsLabel` answers from the labelAt/labelGroupCount baseline: one
 * cheap read, a model call only when membership has genuinely doubled.
 * Anything else would scale Gemini spend with attach volume rather than with
 * promotions — the unbounded mode the header above rules out.
 *
 * Returns what it labelled, because a label write is the one moment a label
 * COLLISION can come into being: the collision-triggered merge
 * (`storyline-label-merge-trigger.ts`) reads these outcomes to know which
 * labels are worth counting. Callers that predate the trigger ignore the
 * return value — which is why it is a return value and not a callback.
 */
export async function labelLinkedStorylines(
  deps: {
    db: Kysely<Database>;
    labeler: Omit<LabelerDeps, "db">;
    log?: { warn: (obj: object, msg: string) => void };
    /**
     * Present when the outcomes may carry withheld formations to resolve
     * (`LinkOutcome.pendingFormation`) — the ingest tail and the late-candidate
     * sweep. The timezone is what a resolution needs: performing the merge the
     * linker withheld recomputes day slots, which are bucketed by calendar.
     * Callers whose outcomes are synthetic merge shapes (the bridge sweeps) have
     * no formations to resolve and rightly omit this.
     */
    formations?: { timeZone: string };
  },
  outcomes: readonly LinkOutcome[],
): Promise<LabelOutcome[]> {
  // FORMATIONS FIRST (ADR-0011's amendment). A deferred formation is a promotion
  // that has not happened yet: the storyline is still provisional, so nothing in
  // the trigger pass below would name it, and the verdict that permits it is the
  // same model call that names it. Resolving afterwards would either label a
  // storyline that turned out not to exist or spend a second call on one that
  // does.
  if (deps.formations !== undefined) {
    // The labeler ENTIRE, plus the calendar. A resolution now names the
    // storyline it forms through the same module this tail names with, so the
    // deps it needs are the same deps — spelling out a subset here is how the
    // two paths drifted in the first place (`wiring.ts`'s header, one layer
    // down).
    const formationDeps: FormationDeps = {
      ...deps.labeler,
      db: deps.db,
      timeZone: deps.formations.timeZone,
    };
    await resolvePendingFormations(formationDeps, outcomes);
  }

  const rank: Record<LabelTrigger, number> = { drift: 0, promotion: 1, merge: 2 };
  const triggers = new Map<string, LabelTrigger>();
  const propose = (storylineId: string, trigger: LabelTrigger): void => {
    const current = triggers.get(storylineId);
    if (current === undefined || rank[trigger] > rank[current]) {
      triggers.set(storylineId, trigger);
    }
  };
  for (const outcome of outcomes) {
    // A birth is not a promotion: a provisional storyline-of-one is invisible
    // as a storyline, so naming it would spend a model call on something no
    // reader can see.
    for (const promoted of outcome.promoted) propose(promoted, "promotion");
    if (outcome.attached) propose(outcome.storylineId, "drift");
    for (const grown of outcome.attachedTo) propose(grown, "drift");
    for (const merge of outcome.merged) propose(merge.winnerId, "merge");
  }

  const labelled: LabelOutcome[] = [];
  for (const [storylineId, trigger] of triggers) {
    try {
      // Whether the storyline is still there to name — gone, or merged away
      // since the batch — is `nameStoryline`'s question now, along with every
      // other precondition of the write. What comes back for one of those is a
      // `skipped` outcome, which the collision trigger reading this array
      // already ignores (it counts model labels only).
      labelled.push(
        await nameStoryline({ db: deps.db, ...deps.labeler }, { storylineId, trigger }),
      );
    } catch (error) {
      deps.log?.warn(
        { err: error, storylineId, trigger },
        "storyline labelling failed after linking; the nightly pass will retry it",
      );
    }
  }
  return labelled;
}
