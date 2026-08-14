import type { Kysely } from "kysely";
import {
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

/**
 * The labeler's service half (ADR-0011): read the members, ask the model, check
 * the answer, fall back, write.
 *
 * Where it fires is the other half of the design, and it is deliberately NOT
 * wired into the linker here — the linker is S3 and does not exist yet. What
 * this exposes is the shape the linker and the backfill will both call:
 * `labelStoryline(deps, { storylineId, trigger })`, with the trigger naming
 * which of ADR-0011's three moments this is. `promotion` and `merge` are events
 * the caller has just written; `drift` is a question this asks of the row.
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

export interface LabelerDeps {
  db: Kysely<Database>;
  /** Null with no `GEMINI_API_KEY`: the fallback path becomes the only path. */
  generator: TextGenerator | null;
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
  });

  return { storylineId: storyline.id, label, source, trigger, modelFailure, groupCount };
}
