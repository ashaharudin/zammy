/**
 * The group→storyline decision (ADR-0011's Linking section) — pure, so it can
 * be replayed over the live corpus by the sweep before any threshold is pinned.
 *
 * The structure is ADR-0009's and survives unchanged, because what it measured
 * is still true: an ANCHOR ("there is a name here") plus corroborating MASS
 * ("and the two keep talking about the same thing around it"). Three things
 * are new, all consequences of a storyline outliving the day it started on:
 *
 *  - **the corpus is a fortnight, not a day.** Day-relative rarity cannot serve
 *    an unbounded storyline: the same token would be rare on Monday and common
 *    on Wednesday, so whether Monday's group joins would depend on which day it
 *    is asked. Measured in docs/TRAILING-CORPUS.md — "leavitt" is 4.4% of its
 *    own day and 0.93% of the trailing corpus, which is the headroom this buys.
 *  - **the right-hand side is a STORYLINE's profile**, not another group's:
 *    tokens at least half its member groups carry. The majority rule that
 *    silenced AP live-blog vocabulary at the group layer, promoted one level,
 *    and the percolation damper — a growing storyline's consensus vocabulary
 *    tightens rather than loosens.
 *  - **dormancy gates the bar.** "Unbounded" cannot mean every dead storyline
 *    competes at normal thresholds forever; accumulation degrades precision
 *    monotonically (ADR-0011, Considered and refused).
 *
 * Nothing here reads or writes. `storyline-linker.ts` is the service that puts
 * these verdicts into the database, and `storyline-sweep-cli.ts` replays them
 * over the archive without one — two callers of one decision, which is what
 * makes "no threshold ships unmeasured" possible at all.
 */

export interface LinkRules {
  /**
   * A shared token anchors only while its trailing-corpus df stays at or below
   * this FRACTION of the corpus. Relative, not absolute: ADR-0009 measured an
   * absolute cap failing when a story's own name climbed with its coverage,
   * and that finding carries forward to the wider corpus unchanged.
   */
  anchorMaxShare: number;
  /**
   * Floor under the share, in articles. A share of a small corpus is noise —
   * an off-peak language, or a window that has only just started filling —
   * and without a floor a thin corpus would refuse every anchor it has.
   */
  anchorDfFloor: number;
  /** Floor on the summed rarity (Σ ln(N/df)) of everything group and storyline share. */
  massThreshold: number;
  /**
   * Days without coverage after which a storyline leaves the normal candidate
   * set (ADR-0011: ~90). It stays matchable, at the dormant bar only.
   */
  dormancyDays: number;
  /**
   * How much harder a dormant storyline is to join: the anchor ceiling is
   * divided by this and the mass floor multiplied by it. One knob because the
   * two must move together — loosening either alone would let ten thousand
   * dead storylines back in through the other.
   */
  dormantStrictness: number;
}

/** A storyline as the decision sees it. No labels, no status strings — facts. */
export interface LinkCandidate {
  id: string;
  /** Tokens at least half its member groups carry. */
  profileTokens: readonly string[];
  /** Its most recent coverage, epoch ms — what dormancy is measured from. */
  lastCoverageMs: number;
  /** Member groups. A storyline of one is provisional and still a candidate. */
  groupCount: number;
}

/** The trailing corpus, as `readTrailingCorpus` returns it. */
export interface Corpus {
  size: number;
  df: ReadonlyMap<string, number>;
}

export interface LinkEvidence {
  /** Σ ln(N/df) over shared tokens. */
  mass: number;
  /** df of the RAREST shared token; Infinity when nothing is shared. */
  anchorDf: number;
  /** How many tokens the two share at all — reported, never thresholded. */
  shared: number;
}

/**
 * The anchor ceiling, in articles. Every caller must agree about this, which is
 * why it is a function and not an expression repeated at three call sites.
 */
export function anchorCeiling(corpusSize: number, rules: LinkRules): number {
  return Math.max(rules.anchorDfFloor, corpusSize * rules.anchorMaxShare);
}

/**
 * The tokens of a group's profile that could ANCHOR a link — the subset
 * candidate retrieval should probe with, rather than the whole profile.
 *
 * This is a restatement of `qualifyingStorylines`, not a second decision, and
 * the proof is short enough to keep here. A candidate is rejected when
 * `evidence.anchorDf > bar.ceiling`, and `anchorDf` is the df of the RAREST
 * token the two share. `barFor` only ever DIVIDES the ceiling (dormancy), so
 * `anchorCeiling` is the loosest bar any candidate faces. Therefore a candidate
 * that qualifies must share at least one token whose window df is at or below
 * that ceiling — and a storyline sharing none of them cannot qualify, whatever
 * else it shares. Retrieving on this subset is a NECESSARY CONDITION, the same
 * kind of retrieval bound `profile_tokens &&` already is.
 *
 * Measured over all 12,366 groups in the dev corpus's trailing window: the
 * median profile is 19 tokens and the median eligible subset is 7, the
 * retrieval goes from 34.9 ms to 2.2 ms at the mean, and it finds 35× the
 * qualifiers while losing NONE — because the whole-profile retrieval was being
 * truncated by `CANDIDATE_LIMIT` on 99% of groups (see the linker's note there).
 *
 * **An absent token is eligible, and that is the load-bearing line.**
 * `linkEvidence` scores a token the corpus has not seen as df 1 — "genuinely
 * the rarest thing there is" — so it always anchors. The filter is therefore
 * "df at or below the ceiling OR not in the map", never a filter over the map's
 * entries: the df counters are written on the same write as the tokens, but
 * `recordStoryDfForArticles` explicitly tolerates losing a batch, so the map
 * having every token is corpus luck rather than an invariant. Written the wrong
 * way round, the failure mode is a silently missed link on the rarest
 * vocabulary there is. (Measured 0 absent of 237,944 profile tokens on the dev
 * corpus, which is why this cannot be left to a test of the happy path alone.)
 *
 * An EMPTY result is meaningful rather than degenerate: it means no token this
 * group carries can anchor anything, so the group has no qualifier to find and
 * the retrieval can be skipped outright. 123 of those 12,366 groups.
 */
export function anchorEligibleTokens(
  groupTokens: readonly string[],
  corpus: Corpus,
  rules: LinkRules,
): string[] {
  const ceiling = anchorCeiling(corpus.size, rules);
  return groupTokens.filter((token) => {
    const df = corpus.df.get(token);
    return df === undefined || df <= ceiling;
  });
}

/**
 * What one group and one storyline share, weighted by how rare it is.
 *
 * Mass, not weighted Jaccard, for ADR-0009's reason and it is stronger here: a
 * storyline accumulates vocabulary across days, so a group joining a
 * three-week-old arc will share a small fraction of its profile by
 * construction. What either side says beyond the overlap is no evidence
 * against the link.
 */
export function linkEvidence(
  groupTokens: readonly string[],
  profileTokens: readonly string[],
  corpus: Corpus,
): LinkEvidence {
  const profile = new Set(profileTokens);
  let mass = 0;
  let anchorDf = Number.POSITIVE_INFINITY;
  let shared = 0;

  for (const token of new Set(groupTokens)) {
    if (!profile.has(token)) continue;
    shared += 1;
    // A token the corpus has not seen scores as df 1. The corpus is maintained
    // on the same write that stores the tokens, so this means "brand new
    // vocabulary" — genuinely the rarest thing there is — not a drifted map.
    const df = Math.max(1, corpus.df.get(token) ?? 1);
    mass += Math.log(Math.max(1, corpus.size / df));
    if (df < anchorDf) anchorDf = df;
  }

  return { mass, anchorDf, shared };
}

/**
 * The bar this candidate must clear: normal, or the dormant one.
 *
 * Dormancy is measured from the storyline's last COVERAGE, not from when it
 * was created or last touched — the trial fourteen months after the crash must
 * still find the crash, and what makes that safe is that the crash has been
 * quiet for fourteen months, not that it is old.
 */
export function barFor(
  candidate: LinkCandidate,
  nowMs: number,
  rules: LinkRules,
  corpusSize: number,
): { ceiling: number; mass: number; dormant: boolean } {
  const idleDays = (nowMs - candidate.lastCoverageMs) / 86_400_000;
  const dormant = idleDays > rules.dormancyDays;
  const ceiling = anchorCeiling(corpusSize, rules);
  return dormant
    ? {
        ceiling: ceiling / rules.dormantStrictness,
        mass: rules.massThreshold * rules.dormantStrictness,
        dormant: true,
      }
    : { ceiling, mass: rules.massThreshold, dormant: false };
}

export interface Qualification {
  candidate: LinkCandidate;
  evidence: LinkEvidence;
  dormant: boolean;
}

/**
 * Every candidate this group qualifies for, best mass first.
 *
 * ALL of them, not just the winner: a group qualifying for two storylines is
 * bridge evidence, and the caller records it. Suppressing it here would make
 * merges impossible to detect and leave err-narrow formation with no cure
 * (ADR-0011 refuses split, so the merge is the only repair there is).
 */
export function qualifyingStorylines(
  groupTokens: readonly string[],
  candidates: readonly LinkCandidate[],
  corpus: Corpus,
  rules: LinkRules,
  nowMs: number,
): Qualification[] {
  const qualified: Qualification[] = [];
  for (const candidate of candidates) {
    const evidence = linkEvidence(groupTokens, candidate.profileTokens, corpus);
    const bar = barFor(candidate, nowMs, rules, corpus.size);
    if (evidence.anchorDf > bar.ceiling || evidence.mass < bar.mass) continue;
    qualified.push({ candidate, evidence, dormant: bar.dormant });
  }
  // Mass descending, then the older storyline, then the id: a replay must
  // produce the same assignment as the run it replays (§7.4), and mass ties
  // are common once a group shares a storyline's whole profile.
  return qualified.sort(
    (a, b) =>
      b.evidence.mass - a.evidence.mass ||
      a.candidate.lastCoverageMs - b.candidate.lastCoverageMs ||
      (a.candidate.id < b.candidate.id ? -1 : 1),
  );
}

/**
 * What a GROUP says, as opposed to what any one of its members says: the tokens
 * at least half its members carry.
 *
 * Unchanged from ADR-0009, where the measurement pass pinned it: the Leavitt
 * day's core group holds four AP "The Latest:" live-blog copies whose
 * descriptions enumerate the whole day's news, and through them the story
 * acquired BLACKPINK and a blood-robot swarm as "coverage". Majority support
 * silences vocabulary only a minority of members carry. For a group of one —
 * every angle piece, and most groups — the profile is simply its own tokens.
 *
 * The storyline side of the comparison is the same rule one level up, derived
 * in SQL by `refreshProfileTokens`; `storylineProfile` below is the in-memory
 * twin the sweep replays with.
 */
export function groupProfile(memberTokens: readonly (readonly string[])[]): string[] {
  if (memberTokens.length === 0) return [];
  if (memberTokens.length === 1) return [...new Set(memberTokens[0]!)];
  const need = Math.ceil(memberTokens.length / 2);
  const support = new Map<string, number>();
  for (const tokens of memberTokens) {
    for (const token of new Set(tokens)) support.set(token, (support.get(token) ?? 0) + 1);
  }
  const profile: string[] = [];
  for (const [token, count] of support) if (count >= need) profile.push(token);
  return profile.sort();
}

/**
 * A storyline's profile from its member groups' profiles: the same majority
 * rule, one level up (ADR-0011).
 *
 * `refreshProfileTokens` in storage is authoritative — it is what candidate
 * retrieval overlaps against — and this must agree with it. It is duplicated
 * rather than shared because the sweep has no database: replaying a month of
 * decisions through SQL would take longer than the corpus it measures, and a
 * threshold nobody can afford to sweep is a threshold that ships unmeasured.
 */
export function storylineProfile(groupTokens: readonly (readonly string[])[]): string[] {
  return groupProfile(groupTokens);
}

/**
 * Bridges: which pair of storylines a group qualified for, canonically ordered
 * so (a,b) and (b,a) are one pair however the qualifiers happened to sort.
 *
 * Only pairs among the qualifiers — a group that clears the bar for three
 * storylines bridges all three pairs, because each pair independently has the
 * evidence. K INDEPENDENT bridges (distinct groups) merge a pair; a single one
 * is refused, since one ambiguous roundup chaining three storylines together is
 * the 1,179-group swallow delivered more slowly (ADR-0011).
 */
export function bridgePairs(
  // Only the ids are read: the caller may hold full qualifications or the
  // thinner record a replay keeps, and neither should have to be widened to
  // satisfy the other.
  qualified: readonly { candidate: { id: string } }[],
): [string, string][] {
  const ids = qualified.map((q) => q.candidate.id);
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i]!;
      const b = ids[j]!;
      pairs.push(a < b ? [a, b] : [b, a]);
    }
  }
  return pairs;
}
