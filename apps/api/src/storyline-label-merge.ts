import { singular } from "./grouping.js";
import { foldDiacritics, trimWordPunctuation } from "./headline-tokens.js";

/**
 * The label-agreement merge (ADR-0011's merge repair, reached through the name
 * rather than through the tokens) — pure, so the plan can be printed before it
 * is written.
 *
 * ## Why a label is evidence at all
 *
 * ADR-0011 gives err-narrow formation exactly one cure — the merge — and hangs
 * it entirely on a GROUP that straddles two storylines (K of them, independent).
 * That works while the arcs share rare vocabulary. It stops working for the case
 * it is needed most: a big running story. Measured on the dev archive, the
 * Strait of Hormuz coverage stood as 25 separate arcs whose ENTIRE shared
 * vocabulary was `{hormuz, strait, iran}` — mass 10.7 against a floor of 20,
 * every token at 2-2.5% of the corpus against a ceiling of 0.2%. No group can
 * bridge them, because the story's own name has become too common to anchor
 * anything, so no bridge is ever recorded and the cure never fires.
 *
 * Reshaping the anchor ceiling does not fix it, and that is measured too
 * (docs/STORYLINE-LINKING.md): every setting loose enough to collapse the
 * Hormuz component also builds a 315-group `com, investing` storyline and 58
 * storylines with no profile at all. The tokens cannot tell "Strait of Hormuz"
 * from "Donald Trump"; both are common, both are grounded, both are names.
 *
 * But the labeler already told them apart. Six of those arcs were independently
 * handed the identical name "Strait of Hormuz Crisis" by a model reading their
 * headlines — which is the semantic judgement no df statistic can make. That
 * agreement is the evidence this module acts on.
 *
 * ## What keeps it precise
 *
 * A label is deliberately non-unique (ADR-0010, docs/STORYLINE-LABELS.md), so
 * agreement ALONE must never merge. Three guards stand with it, and each one
 * refuses a failure the others cannot see:
 *
 *  - **Model labels only.** The bigram fallback names entities and places, not
 *    events — it produced "Strait Hormuz" for sixteen unrelated arcs — and
 *    merging on that is merging on shared vocabulary, which is the anchor rule's
 *    job and percolates when done here. The caller filters by `label_source`.
 *  - **The label must contain a grounded proper noun** (`isName` below). This is
 *    the guard that matters, and the archive supplies its counter-example: the
 *    model also labelled three arcs "Q2 2026 Financial Results" — CVB Financial,
 *    Mitsui, Mayfair Gold, Westaim, unrelated companies reporting earnings — and
 *    their spans overlap, so nothing about time separates them. `properNounEvidence`
 *    does: "Hormuz" is never seen lowercase in the coverage, while "financial",
 *    "results" and "quarter" are, so the Q2 component carries no name and is refused.
 *    docs/STORYLINE-LABELS.md rejected that same test for label VALIDATION as too
 *    strict, and it was right to — a conservative test there leaves a storyline
 *    nameless. Here the calculus inverts: refusing a merge leaves two storylines,
 *    which is the status quo, and conservatism is exactly what is wanted.
 *  - **Spans must overlap or nearly touch.** The disambiguator ADR-0010 already
 *    names: two storylines sharing a label are told apart by date span, so a
 *    "Fort Hood Crash" in 2026 and another in 2031 stay two storylines. An
 *    evolving situation has continuous coverage; `graceDays` is what a quiet
 *    stretch inside one is allowed to be.
 *
 * Merging is transitive WITHIN one label and nowhere else. Three arcs named the
 * same thing whose spans chain A-C-B collapse together even though A and B do
 * not touch, because C covers the gap and all three carry one name. The label is
 * the boundary, which is what makes this bounded where transitive token linking
 * was not (ADR-0009's 1,179-group swallow).
 *
 * Nothing here reads or writes. `storyline-label-merge-service.ts` puts the plan
 * into the database.
 */

export interface LabelMergeRules {
  /**
   * Days of silence a shared label may bridge. A storyline is unbounded in time
   * and an evolving situation goes quiet — a ceasefire holds for a week, then
   * breaks — so requiring strict overlap would refuse the reopening of the very
   * story it is named for.
   *
   * UNMEASURED, and honestly so: in the dev archive every arc of the one
   * qualifying component overlaps every other, so 0 and 30 plan the same merge and
   * the knob is inert. It needs an archive holding a story that stopped and
   * restarted.
   */
  graceDays: number;
  /**
   * Safety valve on one component, in storylines — not a tuning knob, the same
   * argument the linker's candidate-row caps make (`candidateRetrieval`). A model label that turned out
   * both generic and grounded would otherwise collapse an unbounded number of
   * arcs in one pass, and the failure this design exists to prevent is exactly
   * that shape. A refused component is LOGGED and left alone, so the operator
   * sees a name worth looking at rather than a swallow worth reverting.
   */
  maxComponent: number;
}

/** A storyline as the label decision sees it: a name, a span, and its weight. */
export interface LabelMergeCandidate {
  id: string;
  label: string;
  /** Its earliest day slot, epoch ms. */
  spanFromMs: number;
  /** Its latest day slot, epoch ms. */
  spanToMs: number;
  groupCount: number;
}

/** One component: everything that becomes a single storyline. */
export interface LabelMergePlan {
  /**
   * The component's `labelKey` — what to log it by.
   *
   * NOT a label anybody wrote. `sharedLabels` keys its map by `labelKey`, the
   * service passes that key straight in here, so this is the folded words as a
   * SORTED BAG: "Q2 2026 Financial Results" arrives as `2026 financial q2
   * result`. Fine for an operator's log line, which needs a stable handle for a
   * component rather than a name — and worth spelling out, because "the
   * normalized label" is what this said and it read like `normalizeLabel`
   * output.
   */
  label: string;
  winnerId: string;
  /** Merged into the winner, in the order the service should merge them. */
  loserIds: string[];
}

/** A component that agreed on a name and was refused anyway. */
export interface LabelMergeRefusal {
  /** A `labelKey` too — see `LabelMergePlan.label`. */
  label: string;
  storylines: number;
  reason: "no grounded name" | "component too large";
}

/**
 * Fold a label to its comparison form: case, spacing and plurals.
 *
 * Deliberately NOT stopword-elided. "Strait of Hormuz Crisis" and "Strait Hormuz
 * Crisis" stay two labels here, even though ADR-0010's cloud phrasing would
 * treat them as one, because both sides of this comparison come from the model
 * and refusing a merge costs nothing while making one wrongly costs a swallowed
 * storyline. The plural fold is `singular` rather than a second stemmer for the
 * reason grouping shares its own: two stemmers disagreeing about what a word is
 * would make two layers disagree about what a story is.
 *
 * Possessives are trimmed with the corpus tokenizer's own fold rather than a
 * second regex, for that same reason and on live evidence: `singular` alone turned
 * "Dillard's" into `dillard'` while the coverage held `dillard`, and the grounding
 * gate refused a real name because the two sides never met. See
 * `trimWordPunctuation`.
 */
export function normalizeLabel(label: string): string {
  return labelWordForms(label)
    .map((word) => word.folded)
    .join(" ");
}

/**
 * One word of a label in both spellings the system needs it in.
 *
 * The fold is lossy in the direction that matters here: `singular` drops a bare
 * trailing `s` and nothing more, so "crisis" reaches the corpus as `crisi` and
 * "boxes" as `boxe`. `normalizeLabel`'s own doc calls that acceptable, and it is
 * — for a COMPARISON, where both sides fold alike and the spelling is never
 * read. It stops being acceptable the moment a folded word is shown to a reader
 * or sent upstream as a search term, which is what `cloudQuery` does, and what
 * put "gaza crisi" in the hero placeholder and in the command bar.
 *
 * So a caller that displays a label word takes `surface`, and a caller that
 * matches it against the corpus takes `folded` — from the same walk of the same
 * label, so the two can never drift apart the way two regexes would.
 */
export interface LabelWord {
  /** The label's own spelling, lowercased, minus the punctuation that WRAPS a word. */
  surface: string;
  /** The corpus spelling: `surface` under `singular`. */
  folded: string;
}

/**
 * The words of a label, each in both spellings — the single walk `normalizeLabel`
 * and `labelWords` are both written on.
 *
 * Lowercased rather than kept as the model cased it, because both consumers want
 * it lowercase: the corpus side to meet `story_tokens`, and the display side to
 * stand beside the stock examples in the hero placeholder as something a reader
 * would plausibly have typed.
 */
export function labelWordForms(label: string): LabelWord[] {
  return label
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .map(trimWordPunctuation)
    .filter((word) => word.length > 0)
    // `foldDiacritics` on the corpus side only, never on the surface: the corpus
    // spelling has to meet `story_tokens`, which drops accents (the labeler
    // writes "Nino" where the headlines say "Niño"), while the surface is read
    // by a reader and sent upstream, so it keeps the label's own spelling.
    .map((surface) => ({ surface, folded: singular(foldDiacritics(surface)) }));
}

/** The words of a label, folded the way `normalizeLabel` folds them. */
export function labelWords(label: string): string[] {
  return labelWordForms(label).map((word) => word.folded);
}

/**
 * The comparison key two labels must share to count as agreement: the folded
 * words as a sorted bag, so word order stops mattering. "Canada US Trade Deal"
 * and "US Canada Trade Deal" are one name ordered two ways — the model orders
 * the two countries arbitrarily between runs — and exact-string comparison read
 * that as disagreement (measured on the dev archive, 2026-08-20: six live
 * trade-deal arcs in two order-only buckets).
 *
 * A bag, not a set: a repeated word stays repeated, so two labels agree only on
 * the same multiset. Used ONLY for bucketing — `labelWords`, the display label
 * and `label_words` all keep the model's own order.
 */
export function labelKey(label: string): string {
  return labelWords(label).sort().join(" ");
}

/**
 * Do two spans overlap, or come within `graceDays` of each other?
 *
 * Inclusive at both ends: a storyline whose only coverage is one day has
 * `spanFrom === spanTo`, and it must be able to touch its neighbours.
 */
export function spansTouch(
  a: Pick<LabelMergeCandidate, "spanFromMs" | "spanToMs">,
  b: Pick<LabelMergeCandidate, "spanFromMs" | "spanToMs">,
  graceDays: number,
): boolean {
  const grace = Math.max(0, graceDays) * 86_400_000;
  return a.spanFromMs - grace <= b.spanToMs && b.spanFromMs - grace <= a.spanToMs;
}

/**
 * Candidates grouped by `labelKey` — the folded words as a sorted bag — keeping
 * only keys held by more than one storyline, the only ones that can produce a
 * merge. The map key is therefore word-order-blind; everything downstream that
 * reads it (grounding, refusal logs) works on the word set, which the sort
 * preserves.
 *
 * Exported because the service reads coverage per shared label to build the
 * grounding evidence, and doing that for all 258 labelled storylines when two
 * labels are shared would be the whole archive for nothing.
 */
export function sharedLabels(
  candidates: readonly LabelMergeCandidate[],
): Map<string, LabelMergeCandidate[]> {
  const byLabel = new Map<string, LabelMergeCandidate[]>();
  for (const candidate of candidates) {
    const key = labelKey(candidate.label);
    if (key.length === 0) continue;
    const bucket = byLabel.get(key);
    if (bucket) bucket.push(candidate);
    else byLabel.set(key, [candidate]);
  }
  for (const [key, bucket] of byLabel) if (bucket.length < 2) byLabel.delete(key);
  return byLabel;
}

/**
 * The merge plan for one shared label.
 *
 * `isName` answers "does this folded word carry proper-noun evidence in the
 * coverage these arcs hold" — injected rather than computed, because the
 * evidence is a corpus and this module does not read one. The service supplies
 * `properNounEvidence` over the arcs' own members.
 */
export function planLabelMerge(
  label: string,
  candidates: readonly LabelMergeCandidate[],
  isName: (word: string) => boolean,
  rules: LabelMergeRules,
): { plans: LabelMergePlan[]; refusals: LabelMergeRefusal[] } {
  // The grounding guard, before any span arithmetic: a label naming no thing
  // cannot be evidence that two storylines are the same thing.
  if (!labelWords(label).some((word) => isName(word))) {
    return {
      plans: [],
      refusals: [{ label, storylines: candidates.length, reason: "no grounded name" }],
    };
  }

  // Components over "spans touch". Sorted by span start so the walk is
  // deterministic, which a replay of the same night requires.
  const ordered = [...candidates].sort(
    (a, b) => a.spanFromMs - b.spanFromMs || (a.id < b.id ? -1 : 1),
  );
  const seen = new Set<string>();
  const plans: LabelMergePlan[] = [];
  const refusals: LabelMergeRefusal[] = [];

  for (const start of ordered) {
    if (seen.has(start.id)) continue;
    // Breadth-first over the touch relation. Transitive by construction: a
    // storyline joins the component if it touches ANY member, so a chain
    // A-C-B collapses whole even though A and B never meet.
    const component: LabelMergeCandidate[] = [start];
    seen.add(start.id);
    for (let cursor = 0; cursor < component.length; cursor += 1) {
      for (const other of ordered) {
        if (seen.has(other.id)) continue;
        if (!spansTouch(component[cursor]!, other, rules.graceDays)) continue;
        seen.add(other.id);
        component.push(other);
      }
    }
    if (component.length < 2) continue;
    // A valve that cannot be read is a valve that is shut. `NaN` loses every
    // comparison, so `length > NaN` is false and a garbled `--max-component`
    // would silently let the swallow this valve exists to stop straight
    // through — the one direction it must never fail in.
    const maxComponent = Number.isFinite(rules.maxComponent) ? rules.maxComponent : 0;
    if (component.length > maxComponent) {
      refusals.push({ label, storylines: component.length, reason: "component too large" });
      continue;
    }

    // More groups wins, then the earlier span, then the id — the linker's own
    // rule ("more coverage wins, so the surviving UUID is the one more readers
    // are likely to be holding"), with the span as a tiebreak because the arc
    // that started the story is the one whose URL has been around longest.
    const ranked = [...component].sort(
      (a, b) =>
        b.groupCount - a.groupCount ||
        a.spanFromMs - b.spanFromMs ||
        (a.id < b.id ? -1 : 1),
    );
    plans.push({
      label,
      winnerId: ranked[0]!.id,
      loserIds: ranked.slice(1).map((candidate) => candidate.id),
    });
  }

  return { plans, refusals };
}
