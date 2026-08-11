import type { GroupCandidate } from "@zammy/storage";
import { contentTokens } from "./term-scoring.js";

/**
 * Article grouping (ARCHITECTURE 14.3) — the write-time decision: does this
 * article belong with an existing group, or does it start its own?
 *
 * The unit is **a day's coverage of a story, not an event** (§14.3). What
 * follows is the similarity half; the time bucket that bounds it lives in SQL
 * (same APP_TIMEZONE calendar day, same language) — and that bucket is now the
 * whole of the bound, since a newcomer is matched against ANY member of a
 * group rather than its seed alone (ADR-0005). Seed-only comparison was the
 * original rule and measurably lost real syndication: it judged a wire story
 * against whichever article happened to arrive first, not the one it resembles.
 *
 * **Similarity is lexical: Jaccard over headline tokens** (ADR-0005). Not
 * embeddings — §14.3 called grouping the strongest case in this product for
 * vectors, and it may still be, but item 7 priced the ML dependency and the
 * price has not changed. `chooseGroup` is the seam a vector implementation
 * would replace, and nothing above it knows how the decision is made.
 */

// The candidate shape is storage's — it is what the candidate query returns,
// and a local copy of the same fields would be two definitions of one thing.
// Type-only, so this module stays pure and testable without a database.
export type { GroupCandidate };

export interface GroupingRules {
  /**
   * Jaccard floor for two headlines to be the same story.
   *
   * **Unmeasured**, and named as such because item 7's post-mortem was
   * explicitly about shipping a threshold nobody had measured. It is set where
   * near-identical syndicated headlines pass and same-subject-different-story
   * headlines do not, judged on constructed examples rather than labelled
   * data. Tune it with `GROUPING_SIMILARITY_THRESHOLD`; a false merge is worse
   * than a visible duplicate (ADR-0002), so err high.
   */
  threshold: number;
}

/**
 * Two headlines must share at least this many tokens, whatever their Jaccard.
 *
 * The floor is load-bearing, not belt-and-braces: two headlines reducing to
 * the single token `trump` score a perfect 1, and without this every headline
 * naming one person would collapse into one group. It is the lexical analogue
 * of item 7's finding that neither orthography nor similarity is safe alone.
 */
const MIN_SHARED_TOKENS = 2;

/** The distinct content-bearing tokens of a headline (§10.2's tokenizer). */
export function headlineTokens(title: string): string[] {
  return [...new Set(contentTokens(title))];
}

/**
 * The figures a headline quotes, with thousands separators removed so `36,800`
 * and `36800` are one figure.
 *
 * The tokenizer drops anything containing a digit — §10.2's fix for `cve-`
 * fragments ranking first in the cloud — which is right for terms and wrong
 * here: templated headlines differ ONLY in their numbers. "Athabasca Oil
 * Corporation Buys 36,800 Shares" and "…Buys 43,500 Shares" tokenize
 * identically, and ten distinct insider filings merged into one slot on live
 * data because of it.
 */
export function headlineFigures(title: string): Set<string> {
  const found = title.match(/\d[\d.,]*/g) ?? [];
  return new Set(
    found.map((figure) => figure.replaceAll(",", "").replace(/[.,]+$/, "")).filter(Boolean),
  );
}

/**
 * Two headlines that both quote figures, sharing none of them, are not the
 * same story — the numbers ARE the story in that shape of headline.
 *
 * One-sided figures prove nothing: an outlet that puts "2,000 acres" in its
 * headline and one that does not are still covering the same fire, so the rule
 * only fires when both sides quote something and nothing agrees.
 */
function figuresContradict(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const figure of a) if (b.has(figure)) return false;
  return true;
}

/**
 * Jaccard: shared tokens over total distinct tokens.
 *
 * Zero for an empty side rather than NaN — a headline of pure stopwords
 * tokenizes to nothing, and `NaN >= threshold` is false in a way that reads
 * like a passing comparison to anyone skimming.
 */
export function titleSimilarity(a: readonly string[], b: readonly string[]): number {
  return overlap(a, b).similarity;
}

/** Shared-token count and Jaccard in one pass — `chooseGroup` needs both. */
function overlap(
  a: readonly string[],
  b: readonly string[],
): { shared: number; similarity: number } {
  if (a.length === 0 || b.length === 0) return { shared: 0, similarity: 0 };
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const token of right) if (left.has(token)) shared += 1;
  return { shared, similarity: shared / (left.size + right.size - shared) };
}

/**
 * The closest candidate above the bar, or null to start a new group.
 *
 * "Closest", not "first acceptable": with several same-day candidates the
 * nearest headline is the one a reader would call the same story. Ties break
 * by earliest published then lowest id, so a replayed batch — retries make
 * that routine (§7.4) — reaches the same grouping.
 *
 * Candidates include a group's MEMBERS, not only its seed, so an article joins
 * through whichever member it most resembles. On live data that is what
 * rescued a mirror.co.uk piece that duplicated a BBC article almost word for
 * word while scoring 0.375 against the group's arbitrary first arrival.
 */
export function chooseGroup(
  headline: { tokens: readonly string[]; figures: Set<string> },
  candidates: readonly GroupCandidate[],
  rules: GroupingRules,
): GroupCandidate | null {
  let best: { candidate: GroupCandidate; similarity: number } | null = null;

  for (const candidate of candidates) {
    const { shared, similarity } = overlap(headline.tokens, candidate.titleTokens);
    if (shared < MIN_SHARED_TOKENS || similarity < rules.threshold) continue;
    if (figuresContradict(headline.figures, headlineFigures(candidate.title))) continue;
    if (best === null || beats(similarity, candidate, best)) {
      best = { candidate, similarity };
    }
  }

  return best?.candidate ?? null;
}

function beats(
  similarity: number,
  candidate: GroupCandidate,
  best: { candidate: GroupCandidate; similarity: number },
): boolean {
  if (similarity !== best.similarity) return similarity > best.similarity;
  const byTime = candidate.published.getTime() - best.candidate.published.getTime();
  if (byTime !== 0) return byTime < 0;
  return BigInt(candidate.id) < BigInt(best.candidate.id);
}
