import { singular } from "./grouping.js";
import { storyTokens } from "./storyline.js";
import { bigramLabel } from "./bigram-label.js";
import { foldDiacritics, trimWordPunctuation } from "./headline-tokens.js";

/**
 * The storyline LABEL, decided (ADR-0011, "Labels").
 *
 * Everything in this file is pure: which members the model is shown, what it is
 * asked, whether what came back may be used, and what to fall back to. The call
 * itself and the write live in `storyline-naming.ts`, so the judgement can be
 * tested against recorded responses without a network or a database.
 *
 * These stay separately callable and separately tested (ADR-0011: "the decision
 * functions stay pure and swappable"). What the naming module changed is that
 * they now have ONE caller between them on the write path, not that they became
 * private to it — `storyline-coherence.ts` reuses `validateLabel`, and the
 * operator commands still ask `needsLabel` before spending a call.
 *
 * The bar is "a proper noun plus what happened, readable at a glance" — "Fort
 * Hood Crash", "Trump Iran War". ADR-0011 accepted an external model for
 * exactly this and nothing else, on the measured finding that the bigram
 * extractor cannot reach it: it produced 9 phrases from 46 eligible slots, and
 * the ones it produced named topics rather than events.
 *
 * A label is presentation, never identity. Nothing keys off it, two storylines
 * may share one, and a null label renders. That is what makes an external
 * dependency tolerable here: the worst failure is a storyline with no name.
 */

export interface LabelMember {
  title: string;
  description: string | null;
  published: Date;
}

/** Why a label is being made. Carried into logs and the CLI's report. */
export type LabelTrigger = "promotion" | "merge" | "drift";

export interface LabelDecision {
  label: string;
  /** Which mechanism produced it — the fallback rate is a number worth watching. */
  source: "model" | "bigram";
}

/**
 * What `label_source` records for a model-produced label.
 *
 * Provenance, not a category: `bigram` and a model id are both answers to
 * "would a relabel against the currently-configured model change this". Which
 * is why the value has a READER as well as a writer —
 * `backfillStorylines`'s `--relabel` resume compares the stored string against
 * the model it is about to spend on, and treats a difference as "not done yet".
 *
 * The writers were three when this was written and are now one, since the label
 * columns got a single writer (`storyline-naming.ts`); the resume is the second
 * caller, and it is a reader computing what to compare against. Both still go
 * through this function, which is the point.
 *
 * A function, and exported, because the writers and that reader disagreeing is
 * not a hypothetical: `wiring.createLabeler` did not set `modelId`, so the
 * server, the chore and `pnpm label:storylines` all wrote the literal `"model"`
 * while the resume looked for `gemma-3-27b-it` — and a relabel campaign
 * re-bought every row it had already paid for. One expression, one place.
 *
 * The `"model"` fallback survives the fix rather than becoming dead code. It is
 * unreachable from any configured path now (every one crosses `createLabeler`,
 * which sets `modelId` whenever there is a key, and `operator-command.test.ts`
 * pins that over the whole set of commands), but `modelId` is optional on
 * `LabelerDeps` and hand-built deps — tests, and anything that grows one later
 * — can still omit it. For those the honest answer is "a model named this, and
 * we cannot say which": writing `null` instead would read as never labelled,
 * and dropping the fallback would put `undefined` in the column. What made the
 * old literal a bug was not the string, it was that two files chose it
 * separately.
 */
export function modelLabelSource(modelId: string | undefined): string {
  return modelId ?? "model";
}

/**
 * Does this storyline need a label right now?
 *
 * Promotion and merge are events the caller observed, so they are answered by
 * the caller passing them in. DRIFT is the one this decides: a label describes
 * the coverage it was shown, and once membership has multiplied by
 * `driftFactor` it is describing a minority of the story — "Fort Hood Crash"
 * for what is now the investigation.
 *
 * A storyline with no baseline (never labelled, or labelled before the drift
 * column existed) always needs one. A label that came back null counts as a
 * baseline: a storyline the model declined to name is not owed another attempt
 * until its coverage has doubled either, or an unnameable storyline would be
 * re-asked on every pass forever.
 */
export function needsLabel(
  storyline: { labelAt: Date | null; labelGroupCount: number | null },
  input: { groupCount: number; trigger?: LabelTrigger; driftFactor: number },
): boolean {
  if (input.trigger === "promotion" || input.trigger === "merge") return true;
  if (storyline.labelAt === null || storyline.labelGroupCount === null) return true;
  return input.groupCount >= storyline.labelGroupCount * input.driftFactor;
}

/**
 * The members the model is shown: the most recent, plus the ORIGIN.
 *
 * Recent-weighted is ADR-0011's instruction and it is right — a label should
 * follow the story, and "Fort Hood Crash" becoming "Fort Hood Investigation" is
 * the feature. But recency alone loses the event itself on any arc long enough
 * to matter: ten headlines about a verdict do not say what the trial was about.
 * The oldest member is what names the happening, so it always keeps a seat, and
 * the newest fill the rest.
 *
 * Ordered oldest-first on the way out, so the prompt reads as the story ran.
 */
export function selectLabelMembers<T extends LabelMember>(
  members: readonly T[],
  limit: number,
): T[] {
  if (limit <= 0 || members.length === 0) return [];

  const byRecency = [...members].sort(
    (a, b) => b.published.getTime() - a.published.getTime(),
  );
  const origin = byRecency[byRecency.length - 1]!;
  const chosen = byRecency.slice(0, limit);
  if (!chosen.includes(origin)) chosen[chosen.length - 1] = origin;

  return chosen.sort((a, b) => a.published.getTime() - b.published.getTime());
}

/**
 * The prompt. The CONTRACT half — 2–5 words, a proper noun, the event not just
 * the entity, no punctuation — is fixed by ADR-0011 and mirrored exactly by
 * `validateLabel` below; the wording around it is expected to iterate on live
 * output.
 *
 * Descriptions are trimmed rather than sent whole: they are the padding an
 * outlet writes, the model needs them only for disambiguation, and the prompt's
 * size is the per-label cost.
 */
export function buildLabelPrompt(members: readonly LabelMember[]): string {
  const coverage = members
    .map((member, index) => {
      const description = (member.description ?? "").replaceAll(/\s+/g, " ").trim();
      const trimmed = description.length > 200 ? `${description.slice(0, 200)}…` : description;
      return `${index + 1}. ${member.title}${trimmed ? `\n   ${trimmed}` : ""}`;
    })
    .join("\n");

  return [
    "These headlines all cover ONE news story, oldest first.",
    "Name that story the way a newspaper's running-story tag would.",
    "",
    coverage,
    "",
    "Rules:",
    "- Between 2 and 5 words.",
    "- Must contain a proper noun (a place, person, organisation or country).",
    "- Name the EVENT or SITUATION, not just who is involved:",
    '  "Fort Hood Crash", not "Fort Hood"; "Trump Iran War", not "Donald Trump".',
    "- No punctuation, no quotation marks, no trailing period.",
    "- Reply with the name alone and nothing else.",
  ].join("\n");
}

/**
 * Is what came back usable? Returns the cleaned label, or null.
 *
 * Three of the contract's four clauses are mechanical and are enforced here.
 * The fourth — "names the event, not just the entity" — is NOT checkable, and
 * pretending otherwise would be worse than admitting it: "Fort Hood Crash" and
 * "Donald Trump" are both two capitalized words, and no test over tokens tells
 * them apart. The prompt carries that clause; live output is what will judge
 * it, which is why ADR-0011 says the prompt iterates and the contract does not.
 *
 * The proper-noun clause is enforced as GROUNDING rather than as grammar: at
 * least one capitalized word of the label must actually appear in the coverage
 * it names, under the same singular fold the rest of the system uses. Corpus
 * case evidence (`properNounEvidence`) was the alternative and is too strict
 * here — it is conservative by design and headlines are Title Case, so a
 * storyline whose members carry no descriptions would fail every label. What
 * grounding buys is the failure that actually matters: a model inventing a
 * name that appears nowhere in the story.
 */
export function validateLabel(
  raw: string,
  members: readonly LabelMember[],
): string | null {
  // Wrapping only — quotes and emphasis a model puts AROUND its answer. A
  // global strip would take the apostrophe out of Xi'an, which is part of the
  // name rather than part of the packaging.
  let label = raw.replaceAll(/\s+/g, " ").trim();
  for (let pass = 0; pass < 2; pass += 1) {
    label = label
      .replace(/^[\s"'`*_]+/u, "")
      .replace(/[\s"'`*_]+$/u, "")
      .replace(/[.,;:!?]+$/u, "")
      .trim();
  }
  if (label.length === 0) return null;

  // Letters, digits, spaces, and the punctuation that lives INSIDE a name —
  // Xi'an, Guinea-Bissau. Anything else is the model writing a sentence.
  //
  // Digits are admitted on live evidence: the first run refused "Osun Election
  // 2026", which is a good label, on a rule ADR-0011 never wrote — the contract
  // bars PUNCTUATION, and a year is not punctuation. Grounding is unaffected
  // either way, since the tokenizer drops anything containing a digit (§10.2)
  // and only one word has to be grounded.
  if (!/^[\p{L}\p{N}][\p{L}\p{N}'-]*(?: [\p{L}\p{N}][\p{L}\p{N}'-]*)*$/u.test(label)) {
    return null;
  }

  const words = label.split(" ");
  if (words.length < 2 || words.length > 5) return null;

  const vocabulary = new Set(
    members.flatMap((member) => storyTokens(member.title, member.description)),
  );
  // `vocabulary` is folded the way `contentTokens` folds a corpus word: edge
  // punctuation and a possessive `'s` stripped and Latin diacritics dropped,
  // THEN singularized. Folding with `singular` alone leaves a stranded
  // apostrophe — `singular("dillard's")` is `"dillard'"` — so a possessive
  // proper noun could never ground a label; leaving the accents on lets the
  // model's "Nino" miss a corpus that says `niño`, which grounds or refuses a
  // label on whatever its OTHER words happen to be (`foldDiacritics`).
  const grounded = words.some(
    (word) =>
      /^\p{Lu}/u.test(word) &&
      vocabulary.has(singular(foldDiacritics(trimWordPunctuation(word.toLowerCase())))),
  );
  if (!grounded) return null;

  return label;
}

/**
 * The deterministic floor: the bigram extractor with the containment rule
 * removed (`storyline-phrase.ts`). It cannot meet the bar above and is not
 * asked to — it is what stands between an unavailable model and a nameless
 * storyline.
 */
export function fallbackLabel(members: readonly LabelMember[]): string | null {
  return bigramLabel(members);
}
