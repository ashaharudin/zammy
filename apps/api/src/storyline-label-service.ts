import type { Kysely } from "kysely";
import {
  readStoryline,
  readStorylineLabelInput,
  setStorylineLabel,
  type Database,
  type Storyline,
} from "@zammy/storage";
import type { TextGenerator } from "./gemini.js";
import {
  buildLabelPrompt,
  fallbackLabel,
  needsLabel,
  selectLabelMembers,
  validateLabel,
  type LabelTrigger,
} from "./storyline-label.js";
import type { LinkOutcome } from "./storyline-linker.js";

/**
 * The labeler's service half (ADR-0011): read the members, ask the model, check
 * the answer, fall back, write.
 *
 * Where it fires is the other half of the design, and all three of ADR-0011's
 * moments now have a caller. `promotion` and `merge` are events the caller has
 * just written, and they arrive here through `labelLinkedStorylines` below — the
 * tail the ingest path starts and does not wait for. `drift` is a question
 * asked of the row rather than an event, so it belongs to a pass over
 * candidates: the nightly chore, and the operator's `pnpm label:storylines`.
 *
 * Two properties hold at every exit:
 *
 *  - **it never throws for a model reason.** An unavailable, slow, refusing or
 *    contract-breaking Gemini produces a `source: "bigram"` or a null label, and
 *    the caller's promotion stands either way. A storyline with no label renders.
 *  - **it always stamps the drift baseline**, including when the label came out
 *    null. Otherwise an unnameable storyline is re-asked on every pass forever,
 *    which turns a storyline-volume cost into an unbounded one.
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
 */
export async function labelLinkedStorylines(
  deps: {
    db: Kysely<Database>;
    labeler: Omit<LabelerDeps, "db">;
    log?: { warn: (obj: object, msg: string) => void };
  },
  outcomes: readonly LinkOutcome[],
): Promise<void> {
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

  for (const [storylineId, trigger] of triggers) {
    try {
      const storyline = await readStoryline(deps.db, storylineId);
      // Gone or merged away since the batch: whatever absorbed it will be
      // labelled under its own outcome.
      if (!storyline || storyline.mergedInto !== null) continue;
      await labelStoryline({ db: deps.db, ...deps.labeler }, { storyline, trigger });
    } catch (error) {
      deps.log?.warn(
        { err: error, storylineId, trigger },
        "storyline labelling failed after linking; the nightly pass will retry it",
      );
    }
  }
}

export interface LabelerDeps {
  db: Kysely<Database>;
  /** Null with no `GEMINI_API_KEY`: the fallback path becomes the only path. */
  generator: TextGenerator | null;
  /**
   * How a model-produced label is recorded — the configured model id. Stored on
   * the row so a relabel campaign can ask "is this label from the model I have
   * now", which is what makes such a campaign resumable. Defaults to the
   * unhelpful-but-honest `"model"` when a caller does not say.
   */
  modelId?: string;
  sampleSize: number;
  driftFactor: number;
  now?: () => Date;
  logger?: {
    warn(fields: Record<string, unknown>, message: string): void;
    debug?(fields: Record<string, unknown>, message: string): void;
  };
}

export interface LabelOutcome {
  storylineId: string;
  label: string | null;
  /** How the label was produced, or why there is none. */
  source: "model" | "bigram" | "none" | "skipped";
  trigger: LabelTrigger;
  /** Set when the model was asked and did not deliver a usable label. */
  modelFailure?: string;
  groupCount: number;
}

/**
 * Label one storyline. `trigger` is `promotion` or `merge` when the caller has
 * just made one of those true, and `drift` when it is only asking.
 */
export async function labelStoryline(
  deps: LabelerDeps,
  input: {
    storyline: Pick<Storyline, "id" | "labelAt" | "labelGroupCount">;
    trigger: LabelTrigger;
  },
): Promise<LabelOutcome> {
  const now = deps.now ?? (() => new Date());
  const { storyline, trigger } = input;

  const { groupCount, members } = await readStorylineLabelInput(deps.db, {
    storylineId: storyline.id,
    limit: deps.sampleSize,
  });

  if (
    !needsLabel(storyline, { groupCount, trigger, driftFactor: deps.driftFactor })
  ) {
    return { storylineId: storyline.id, label: null, source: "skipped", trigger, groupCount };
  }

  // A storyline with no member articles has nothing to name — and nothing to
  // fall back to either. Stamping the baseline would be wrong here, because
  // this is a transient state (a group whose articles were retained away),
  // not a storyline the labeler has judged.
  if (members.length === 0) {
    return { storylineId: storyline.id, label: null, source: "none", trigger, groupCount };
  }

  const sample = selectLabelMembers(members, deps.sampleSize);

  let label: string | null = null;
  let source: LabelOutcome["source"] = "none";
  let modelFailure: string | undefined;

  if (deps.generator) {
    const result = await deps.generator.generate({ prompt: buildLabelPrompt(sample) });
    if (result.ok) {
      const validated = validateLabel(result.text, sample);
      if (validated) {
        label = validated;
        source = "model";
      } else {
        // The raw text is kept in the log line on purpose: the prompt is
        // expected to iterate on live output (ADR-0011), and the labels it
        // gets REFUSED are the only evidence of which way to iterate.
        modelFailure = `contract: ${result.text.slice(0, 80)}`;
      }
    } else {
      modelFailure = result.reason;
    }
  } else {
    modelFailure = "no generator configured";
  }

  if (label === null) {
    const fallback = fallbackLabel(sample);
    if (fallback) {
      label = fallback;
      source = "bigram";
    }
    deps.logger?.warn(
      { storylineId: storyline.id, trigger, reason: modelFailure, fallback },
      "storyline label fell back to the bigram extractor",
    );
  }

  await setStorylineLabel(deps.db, {
    storylineId: storyline.id,
    label,
    labelAt: now(),
    labelGroupCount: groupCount,
    // Provenance, not a category: `bigram` and a model id are both answers to
    // "would a relabel against the currently-configured model change this".
    labelSource:
      source === "model" ? (deps.modelId ?? "model") : source === "bigram" ? "bigram" : null,
  });

  return { storylineId: storyline.id, label, source, trigger, modelFailure, groupCount };
}
