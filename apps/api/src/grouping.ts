import type { GroupCandidate } from "@zammy/storage";
import { contentTokens, stripSourceAttribution } from "./headline-tokens.js";

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

/**
 * Bump this whenever `headlineTokens` changes what it produces.
 *
 * `title_tokens` is a materialized derivation of a rule that has already
 * changed twice, and every row written under the old rule keeps comparing with
 * the old vocabulary — silently. Live measurement after plural folding shipped:
 * a pair scoring 0.538 under today's tokenizer scored 0.429 against the stored
 * tokens, on either side of the 0.50 bar. The version is what turns that from
 * invisible decay into a countable backlog `pnpm regroup` can clear.
 *
 *   1 — content tokens, digits dropped (§10.2)
 *   2 — plurals folded (ADR-0005)
 *   3 — wire-service and desk stopwords added (ADR-0007)
 *   4 — story tokens (title+description) materialized alongside (ADR-0009);
 *       `headlineTokens` itself is unchanged, but rows below 4 have no
 *       `story_tokens` and are invisible to the storyline layer until
 *       re-derived.
 *   5 — typographic apostrophe (U+2019) folded to ASCII before splitting
 *       (issue #101), so "doesn't" survives whole instead of splitting into
 *       "doesn" + "t" at the curly quote.
 *   6 — the outlet's own name peeled off the end of a title
 *       (`stripSourceAttribution`). Rows below 6 carry `winnipeg`,
 *       `globalnew`, `ca` and the like as if they were subject matter, which
 *       is what the storyline linker then matched them on.
 *
 * `pnpm regroup --tokens-only` is not the whole repair for 6, because this
 * version changed `story_tokens` rather than only `title_tokens`. Three steps,
 * in order, and each one's absence is silent:
 *
 *   1. `pnpm regroup --tokens-only` — re-derives the stored tokens.
 *   2. `pnpm story:df --rebuild` — `recordGrouping` writes `story_tokens` but
 *      never `story_token_days` (docs/TRAILING-CORPUS.md), so every df the
 *      linker reads still counts the peeled tokens until this runs.
 *   3. `pnpm backfill:storylines --restart` — ADR-0011 refuses to split an
 *      existing arc, so arcs already built on the old vocabulary can only be
 *      replayed. `--restart` mints new UUIDs and discards the label inventory
 *      with them; the cloud is empty until a label campaign runs, and the
 *      timeline is unaffected.
 */
export const TOKENIZER_VERSION = 6;

/**
 * The distinct content-bearing tokens of a headline (§10.2's tokenizer),
 * singularized.
 *
 * **Grouping stems; the cloud does not.** A term in the cloud is a surface
 * form, not a concept (CONTEXT.md) — "China" and "Chinese" are two terms and
 * both may appear. Grouping asks a different question: whether two headlines
 * describe one story, and there `chiefs` and `chief` are the same word. So the
 * stemmer lives here, over the shared tokenizer, and `contentTokens` keeps
 * returning surface forms to §10.3.
 */
export function headlineTokens(title: string): string[] {
  return [...new Set(contentTokens(stripSourceAttribution(title)).map(singular))];
}

/**
 * Plurals only — deliberately not a full stemmer.
 *
 * §14.7's warning about orthographic tricks applies here, if more weakly than
 * it did to merging single cloud terms: a wrong stem lowers or raises one
 * similarity score among many, rather than deleting a term outright. Measured
 * on 2,713 live articles, plural-only added 40 grouped articles and removed a
 * single-outlet merge; extending it to strip `-ing`/`-ed` added 22 more with
 * no such improvement, and did not even unify `urge`/`urging` — that needs
 * Porter's consonant-vowel restoration, which is a different order of
 * complexity for a gain nobody has measured (ADR-0005).
 *
 * Consistency matters more than linguistic correctness: `series` → `serie`
 * is wrong as English and harmless here, because both sides map alike.
 *
 * Exported for the storyline layer (ADR-0009), which folds title AND
 * description tokens and must stem them identically — two stemmers disagreeing
 * about what a word is would make the two layers disagree about what a story
 * is, the same failure mode that keeps `contentTokens` shared.
 */
export function singular(token: string): string {
  if (token.endsWith("ss")) return token; // press, boss, glass
  if (token.endsWith("ies") && token.length >= 5) return `${token.slice(0, -3)}y`;
  // Drop the final `s` and nothing more, as Porter's first step does. The
  // tempting extra rule — strip `es` after s/x/z/ch/sh, to reach `box` from
  // `boxes` — turns `releases` into `releas`, and mangling a word that appears
  // in half the day's political headlines costs more than `boxe` does. `boxe`
  // is ugly and harmless; both sides map to it alike.
  if (token.endsWith("s") && token.length >= 4) return token.slice(0, -1);
  return token;
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
  // Peeled first, or an outlet's own number becomes the story's: "Fox 5
  // Atlanta" and "WGN 9" quote {5} and {9}, share nothing, and
  // `figuresContradict` then refuses two reports of one event on the strength
  // of two channel numbers.
  const found = stripSourceAttribution(title).match(/\d[\d.,]*/g) ?? [];
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
  return rankedMatches(headline, candidates, rules)[0] ?? null;
}

/**
 * EVERY candidate this headline is the same story as, closest first.
 *
 * `chooseGroup` answers "which group does this article join?" and throws the
 * rest away. That discard was a bug in disguise: an article matching two
 * groups joins the better one, and the other match — often a lone article
 * waiting for exactly this story — is never reconsidered, because grouping
 * evaluates an article once, at creation. A live Daily Mail piece sat beside
 * a 6-article group it scored 0.538 against for precisely that reason.
 *
 * The caller uses the runners-up to adopt groups of one into the winner, so
 * best-match still decides WHICH group, but no longer decides who is left out.
 */
export function rankedMatches(
  headline: { tokens: readonly string[]; figures: Set<string> },
  candidates: readonly GroupCandidate[],
  rules: GroupingRules,
): GroupCandidate[] {
  const matches: Array<{ candidate: GroupCandidate; similarity: number }> = [];

  for (const candidate of candidates) {
    const { shared, similarity } = overlap(headline.tokens, candidate.titleTokens);
    if (shared < MIN_SHARED_TOKENS || similarity < rules.threshold) continue;
    if (figuresContradict(headline.figures, headlineFigures(candidate.title))) continue;
    matches.push({ candidate, similarity });
  }

  // Same order the single-winner rule used: similarity, then earliest
  // published, then lowest id — so a replayed batch reaches the same grouping.
  matches.sort((a, b) => (beats(a.similarity, a.candidate, b) ? -1 : 1));
  return matches.map((match) => match.candidate);
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
