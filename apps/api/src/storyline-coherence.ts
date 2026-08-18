import { validateLabel, type LabelMember } from "./storyline-label.js";

/**
 * Asking a model whether a storyline is ONE STORY at all — the semantic half of
 * the label call, which today is computed and thrown away.
 *
 * ## Why this exists
 *
 * The linker's evidence is an ANCHOR (a rare shared token) plus corroborating
 * MASS. Measured against the archive's hand-judged storylines, that evidence
 * cannot tell "these cover one event" from "these share a word", and no
 * rearrangement of it can — docs/STORYLINE-LINKING.md, "What the anchor rule
 * cannot see", records thirty-one settings across five independent families,
 * every one of which destroys more model-named arcs than it prevents declined
 * piles. The distinction is between an EVENT and an entity, a beat, a
 * source's template or a coincidence of vocabulary, and every one of those
 * looks identical in document frequency.
 *
 * ADR-0011 named this seam in advance: an LLM verdict "does not ship now …
 * while auto-merge exists to heal its misses", and the linking seam "is
 * explicitly where an LLM verdict could slot in later if token evidence proves
 * insufficient". The measurement above is that proof.
 *
 * ## Why it is free
 *
 * A promotion already makes exactly one model call — the promotion label
 * (`storyline-label-service.ts`). A model shown two unrelated articles and
 * ordered to name their shared story either invents a name or writes a
 * sentence, and `validateLabel` refuses it; the storyline then keeps a bigram
 * label and stands. That refusal is the verdict, arriving as a formatting
 * failure and discarded as one. Asking for the verdict OUTRIGHT costs no extra
 * call and turns an accident into evidence.
 *
 * ## Why the three-way answer matters more than the prompt
 *
 * A gate that dissolves storylines must distinguish "the model says these are
 * unrelated" from "the model did not answer". They are not close: the dev
 * archive's free-tier key has a 500-request DAILY quota, and it was exhausted
 * by the labelling campaign — so an implementation that treats silence as a
 * refusal would dissolve the archive on a quiet Tuesday. `readCoherenceReply`
 * returns three cases and never collapses them:
 *
 *  - `named`     — a usable label. The storyline is one story; use the name.
 *  - `incoherent` — the model explicitly said these are not one story.
 *  - `unusable`  — anything else: unavailable, timed out, out of quota, or an
 *    answer that broke the contract. The caller must fall back to today's
 *    behaviour, which is to KEEP the storyline and label it from bigrams.
 *
 * Only `incoherent` may act. That keeps the labeler's founding property — "the
 * worst failure is a storyline with no name" — from quietly becoming "the worst
 * failure is no storyline".
 *
 * Nothing here calls a model or touches a database, so the judgement is tested
 * against recorded replies the way `gemini.ts` is.
 */

/**
 * The sentinel. Upper case and unpunctuated so it cannot collide with a label:
 * `validateLabel` caps a label at five words and this is four, but it also
 * requires a word GROUNDED in the coverage, and no storyline's vocabulary
 * contains "NOT ONE STORY".
 */
export const INCOHERENT_SENTINEL = "NOT ONE STORY";

export type CoherenceReply =
  | { kind: "named"; label: string }
  | { kind: "incoherent" }
  | { kind: "unusable"; reason: string };

/**
 * The prompt: `buildLabelPrompt`'s successor, with the decline made available.
 *
 * The change that matters is the FIRST line. The shipped label prompt opens
 * "These headlines all cover ONE news story", which asserts the very thing in
 * question — a model told the answer will supply a name for two unrelated
 * shootings, and the archive is full of the ones it supplied. Here the framing
 * is honest about where the grouping came from, and the decline is offered
 * before the naming rules rather than after them.
 *
 * The three disqualifiers are spelled out because they are the failure
 * categories the declined set actually holds, in its own proportions: an entity
 * two stories share (ADR-0011's forbidden "Donald Trump"), a beat or a market,
 * a recurring column or newsletter whose furniture is the shared vocabulary,
 * and a turn of phrase. "Fatally shot" and "charging EV" are both in the
 * archive; so is a personal-finance forum thread that reached the Kyle Shanahan
 * crash through "car accident".
 *
 * What is NOT a disqualifier is spelled out too, and matters as much: follow-ups,
 * reactions and analysis ARE the same story, and an arc is supposed to
 * accumulate them. Without that clause the gate would refuse exactly the
 * long-running coverage the storyline model exists to hold together.
 *
 * The wording below is a MEASURED artifact — the 85.2% / 31.4% matrix and the
 * 43%-of-mature-arcs figure in docs/STORYLINE-LINKING.md were produced by this
 * exact text. That is why "a topic" stands despite CONTEXT.md reserving the
 * word for searches: it is model-facing prose, not repo vocabulary, and editing
 * it — even a synonym — makes every recorded number describe a different
 * prompt. Change it only alongside a rerun of `measure:storyline-coherence`.
 */
export function buildCoherencePrompt(members: readonly LabelMember[]): string {
  const coverage = members
    .map((member, index) => {
      const description = (member.description ?? "").replaceAll(/\s+/g, " ").trim();
      const trimmed = description.length > 200 ? `${description.slice(0, 200)}…` : description;
      return `${index + 1}. ${member.title}${trimmed ? `\n   ${trimmed}` : ""}`;
    })
    .join("\n");

  return [
    "These headlines were grouped together automatically, by matching rare words.",
    "That heuristic is sometimes wrong: they may all cover ONE news story, or they",
    "may be unrelated items that merely share some vocabulary.",
    "",
    coverage,
    "",
    "First decide: do these all cover one specific event or evolving situation?",
    "",
    "- Coverage of the SAME happening — including follow-ups, reactions, analysis",
    "  and different angles on it — IS one story.",
    "- Items that share only a person, a place, a team, a market, a topic, a",
    "  recurring column or a turn of phrase, while reporting DIFFERENT happenings,",
    "  are NOT one story.",
    "",
    `If they are NOT one story, reply with exactly: ${INCOHERENT_SENTINEL}`,
    "",
    "Otherwise name that story the way a newspaper's running-story tag would:",
    "- Between 2 and 5 words.",
    "- Must contain a proper noun (a place, person, organisation or country).",
    "- Name the EVENT or SITUATION, not just who is involved:",
    '  "Fort Hood Crash", not "Fort Hood"; "Trump Iran War", not "Donald Trump".',
    "- No punctuation, no quotation marks, no trailing period.",
    "- Reply with the name alone and nothing else.",
  ].join("\n");
}

/**
 * Read one reply. `raw` is null when the model was not reached at all.
 *
 * The sentinel is matched on a PREFIX of the normalized text, not on equality:
 * a model that answers "NOT ONE STORY — these are two different shootings" has
 * decided, and holding it to punctuation would score its decision as a
 * formatting failure and keep the pile. The reverse mistake is the one to fear,
 * so the match is anchored at the start: a label may not contain the sentence
 * anywhere and be read as a refusal.
 */
export function readCoherenceReply(
  raw: string | null,
  members: readonly LabelMember[],
): CoherenceReply {
  if (raw === null) return { kind: "unusable", reason: "no reply" };

  const normalized = raw.replaceAll(/\s+/g, " ").trim();
  // Strip the wrapping a model puts AROUND an answer before testing the
  // sentinel — the same packaging `validateLabel` strips — or a quoted refusal
  // reads as a contract failure and the pile stands.
  const unwrapped = normalized.replace(/^[\s"'`*_]+/u, "");
  if (unwrapped.toUpperCase().startsWith(INCOHERENT_SENTINEL)) return { kind: "incoherent" };

  const label = validateLabel(raw, members);
  if (label !== null) return { kind: "named", label };
  return { kind: "unusable", reason: `contract: ${normalized.slice(0, 80)}` };
}

/**
 * May an `incoherent` verdict act on THIS storyline? Measured, and the answer is
 * almost always no.
 *
 * The verdict's accuracy depends entirely on how much coverage it is shown.
 * docs/STORYLINE-LINKING.md, "…and on mature arcs it must never run": at two
 * groups it refuses 85.2% of the declined set for a true cost of 1–5 in 86, but
 * over the archive's 21 named arcs of 20 groups or more it refuses **nine, seven
 * of them genuine events** — including `el-sayed / michigan / primary / senate`,
 * which the anchor-share section holds up as the model of event-shaped coverage.
 * A mature arc spans rumour, reaction, analysis and adjacent players, and the
 * prompt's own disqualifiers ("share only a person, a place, a team, a market")
 * make that breadth read as incoherence.
 *
 * So the gate is scoped to the moment a storyline becomes real and no other:
 *
 *  - `promotion` where the winner **was a provisional-of-one** — two singletons
 *    becoming a storyline. This is the formation the piles come from, and the
 *    only case with a formation left to withhold.
 *  - `promotion` onto an established arc, `merge`, `drift`: no. A join to a
 *    30-group arc is not a formation; `merge` already costs K independent bridges
 *    plus label agreement; and `drift` fires on every doubling of membership,
 *    which is precisely where the 43% was measured.
 *
 * This is a function rather than a comment because the labeler already fires on
 * all three triggers (`labelLinkedStorylines`), so the unscoped wiring — pass the
 * coherence prompt wherever a label is made — is both the obvious implementation
 * and the one that dissolves 43% of the archive's mature arcs. The linker is its
 * one caller, at the moment it decides whether to withhold; the rule lives here,
 * with the measurement that scoped it, rather than inlined there.
 */
export function mayRefuseFormation(input: {
  trigger: "promotion" | "merge" | "drift";
  /** Member groups the winning storyline held BEFORE this arrival. */
  groupCountBefore: number;
}): boolean {
  return input.trigger === "promotion" && input.groupCountBefore === 1;
}
