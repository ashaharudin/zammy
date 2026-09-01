import type { Kysely } from "kysely";
import {
  readStoryline,
  readStorylineLabelInput,
  setStorylineLabel,
  type Database,
} from "@zammy/storage";
import type { TextGenerator } from "./gemini.js";
import { labelWords } from "./storyline-label-merge.js";
import {
  buildLabelPrompt,
  fallbackLabel,
  modelLabelSource,
  needsLabel,
  selectLabelMembers,
  validateLabel,
  type LabelTrigger,
} from "./storyline-label.js";

/**
 * NAMING a storyline — the whole transaction, and the only writer of it
 * (ADR-0011, "Labels").
 *
 * A label is five columns that mean nothing apart: `label`, `label_words`,
 * `label_at`, `label_group_count`, `label_source`. Until this module existed
 * two files wrote all five. `storyline-label-service.ts` wrote them at
 * promotion, on merge and on drift; `storyline-formation.ts` wrote them AGAIN
 * when the coherence gate performed a withheld formation, from its own re-read
 * of the members, its own `selectLabelMembers`, and its own `fallbackLabel`.
 * The two were held in step by nothing but a comment on each side pointing at
 * the other, and a five-field write is exactly the shape that decays silently:
 * a writer that stopped setting `labelWords` would disable label surfacing
 * (ADR-0011, as amended) for every storyline that path forms, and no test would
 * have noticed.
 *
 * They had already drifted, on an invariant `packages/storage/src/storylines.ts`
 * states outright — see "the empty-coverage case" below, which is the one
 * question this consolidation had to answer rather than preserve.
 *
 * This is `wiring.ts`'s argument, applied one layer down. That header says a
 * decision belongs in one place because two processes building it separately
 * drift without anything recording which bar was applied; here the decision is
 * "what a storyline is called and how we came to call it", and the row records
 * only the answer, never which writer produced it.
 *
 * ## What a caller has to know
 *
 * `nameStoryline(deps, { storylineId, trigger })`. Not the five pure functions,
 * not the prompt, not the two validators, not the fold, not the five columns.
 * Whether the storyline still exists, whether it needs a name at all, whether
 * the model may be asked, what to do when it refuses — all of that is behind
 * the call, and every path out of it leaves the row consistent.
 *
 * Two properties hold at every exit, inherited from the service half this
 * replaces:
 *
 *  - **it never throws for a model reason.** An unavailable, slow, refusing or
 *    contract-breaking model produces a `source: "bigram"` or a null label, and
 *    the caller's promotion stands either way. A storyline with no label
 *    renders.
 *  - **it stamps the drift baseline whenever it ran**, including when the label
 *    came out null. Otherwise an unnameable storyline is re-asked on every pass
 *    for ever, which turns a storyline-volume cost into an unbounded one.
 *
 * ## Naming without a second model call
 *
 * The coherence gate (`storyline-coherence.ts`, ADR-0011's amendment) asks a
 * model whether two groups are one story, and a model that can NAME the story
 * has thereby said it is one — one call, two answers. So the formation path
 * arrives here already holding the name, and `asked` is how it hands it over:
 * the model half of the work is skipped and the write half is not duplicated.
 * `asked` is also how that path says "the model was already asked and gave
 * nothing usable" — which must not be re-read as "nobody has asked yet", or the
 * gate's one call would become two.
 */

export interface LabelerDeps {
  db: Kysely<Database>;
  /** Null with no `GEMINI_API_KEY`: the fallback path becomes the only path. */
  generator: TextGenerator | null;
  /**
   * How a model-produced label is recorded — the configured model id. Stored on
   * the row so a relabel campaign can ask "is this label from the model I have
   * now", which is what makes such a campaign resumable.
   *
   * `wiring.createLabeler` always sets it when there is a key, and every
   * configured path crosses `createLabeler`, so the `"model"` default is
   * unreachable in production and belongs to deps built by hand
   * (`modelLabelSource` says why it stays).
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
 * A model answer the caller has already paid for.
 *
 * Present, it replaces the model call rather than adding to it — the caller is
 * asserting that this storyline's one model call has already happened. Absent,
 * this module makes the call itself.
 */
export type ModelAnswer =
  /** A usable name, and the moment the reply carrying it arrived. */
  | { label: string; at: Date }
  /** Asked and nothing usable came back — or deliberately not asked at all. */
  | { label: null; reason: string };

/**
 * Give one storyline its name, and write every column that records it.
 *
 * `trigger` is `promotion` or `merge` when the caller has just made one of
 * those true, and `drift` when it is only asking — the one case where the
 * baseline on the row, not the caller, decides whether anything happens.
 */
export async function nameStoryline(
  deps: LabelerDeps,
  input: {
    storylineId: string;
    trigger: LabelTrigger;
    /** A model answer the caller already holds; see `ModelAnswer`. */
    asked?: ModelAnswer;
  },
): Promise<LabelOutcome> {
  const now = deps.now ?? (() => new Date());
  const { storylineId, trigger, asked } = input;

  // Gone or merged away since the caller decided to name it. An alias is not a
  // storyline, and whatever absorbed this one is named under its own trigger —
  // `setStorylineLabel` would no-op on the `merged_into` guard anyway, so the
  // only thing at stake is reporting a write that did not happen.
  const storyline = await readStoryline(deps.db, storylineId);
  if (!storyline || storyline.mergedInto !== null) {
    return { storylineId, label: null, source: "skipped", trigger, groupCount: 0 };
  }

  const { groupCount, members } = await readStorylineLabelInput(deps.db, {
    storylineId,
    limit: deps.sampleSize,
  });

  if (!needsLabel(storyline, { groupCount, trigger, driftFactor: deps.driftFactor })) {
    return { storylineId, label: null, source: "skipped", trigger, groupCount };
  }

  // THE EMPTY-COVERAGE CASE, decided here because it is the one place that can
  // decide it once. A storyline with no member articles has nothing to show a
  // model and nothing for the bigram extractor to read, so no name can come out
  // of this call — and the two writers this module replaces disagreed about
  // what to record for it. The labeler returned without writing; the formation
  // path had no such branch and stamped the baseline on a null label.
  //
  // Not writing is the correct half, and it is the storage invariant read
  // properly rather than an exception to it. `setStorylineLabel`'s
  // `labelGroupCount` is stamped on a null label because "a storyline the model
  // REFUSED to name is not owed another attempt" — a judgement, made about
  // coverage somebody looked at. Empty coverage is not a judgement: nobody was
  // asked, because there was nothing to ask about. It is also transient in the
  // direction that matters — retention took the articles a group's storyline
  // still lists, and a later fetch can put coverage back — so stamping would
  // hold the row nameless until its membership DOUBLED, on the strength of a
  // verdict nobody gave. `storyline-formation.ts:122` already refuses to record
  // a refusal on exactly this condition, in exactly these words; this is the
  // same rule reaching the label columns.
  //
  // What it costs is one cheap read per pass for a storyline that cannot be
  // named — never a model call, since this returns before the generator is
  // reached. That is not the unbounded cost the baseline exists to prevent.
  //
  // An `asked` name survives the branch: coverage was there when the model saw
  // it, and a name in hand is a name to write.
  if (members.length === 0 && (asked === undefined || asked.label === null)) {
    return { storylineId, label: null, source: "none", trigger, groupCount };
  }

  const sample = selectLabelMembers(members, deps.sampleSize);

  let label: string | null = null;
  let source: LabelOutcome["source"] = "none";
  let modelFailure: string | undefined;
  let labelAt: Date | null = null;

  if (asked !== undefined) {
    if (asked.label !== null) {
      label = asked.label;
      source = "model";
      // The reply's own moment, not this write's: the drift clock should date
      // from when the model looked at the coverage.
      labelAt = asked.at;
    } else {
      modelFailure = asked.reason;
    }
  } else if (deps.generator) {
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
      { storylineId, trigger, reason: modelFailure, fallback },
      "storyline label fell back to the bigram extractor",
    );
  }

  await setStorylineLabel(deps.db, {
    storylineId,
    label,
    // The label's own words, folded once here so `label_words` and
    // `profile_tokens` hold one spelling of a word between them (ADR-0011, as
    // amended). Null label, no words — there is nothing to surface it by.
    labelWords: label === null ? [] : labelWords(label),
    labelAt: labelAt ?? now(),
    labelGroupCount: groupCount,
    // Provenance, decided in one place for the writers and the `--relabel`
    // resume that reads them back (`modelLabelSource`).
    labelSource:
      source === "model" ? modelLabelSource(deps.modelId) : source === "bigram" ? "bigram" : null,
  });

  return { storylineId, label, source, trigger, modelFailure, groupCount };
}
