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
 * truncated by the 200-row cap on 99% of groups (`WHOLE_PROFILE_CANDIDATE_LIMIT`).
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
 * Row cap for the NARROWED probe, and it is a census of that probe rather than a
 * feel. Over all 12,366 groups in the dev archive's trailing window the
 * anchor-eligible retrieval returns p50 78 rows, p99 684, max 2,625:
 *
 *   | cap   | binds on      | qualifiers it discards |
 *   |-------|---------------|------------------------|
 *   | 200   | 1,131/12,366  | ~10% of them           |
 *   | 1,000 | 39/12,366     | 0 of 1,181 sampled     |
 *   | 4,000 | 0/12,366      | 0                      |
 *
 * 4,000 because it is the first round value the whole window clears, at ~1.5×
 * the observed max and ~24% of the 17,008 live storylines — a bound on the
 * query, not a participant in the decision.
 *
 * What it still guards is narrower than "a pathological token" and worth naming,
 * because narrowing does not make the fan-out structurally small: a token can be
 * rare in the 14-day df window and still sit in many long-lived storyline
 * profiles, since storylines outlive the window that measures them. `openai` on
 * this corpus has a window df of 27 — comfortably anchor-eligible — and appears
 * in 73 live profiles. A group carrying a dozen tokens like that legitimately
 * probes into ~2,600 storylines, and a corpus ten times deeper could do worse.
 */
const NARROWED_CANDIDATE_LIMIT = 4_000;

/**
 * Row cap for the WHOLE-PROFILE probe — the value that shipped from the start,
 * documented as "a safety valve for a pathological token, not a tuning knob".
 *
 * It was not a valve. Probing with the whole profile it bound on **12,266 of
 * 12,366** window groups, whose median profile overlaps ~1,903 live storylines,
 * so the cut was the normal operating point: ~90% of the candidate set
 * discarded, ordered by `last_coverage` recency, which is not what the decision
 * reads. The thresholds it truncated below were pinned by a replay with no cap
 * at all, so production ran a capped decision against bars certified on an
 * uncapped one (docs/VERCEL-PHASE-0-FINDINGS.md §2.5).
 *
 * It stays at 200 anyway, because with the broad probe it is the only bound
 * there is — see `candidateRetrieval`.
 */
const WHOLE_PROFILE_CANDIDATE_LIMIT = 200;

/** How to retrieve candidates: what to probe with, and how much may come back. */
export interface CandidateRetrieval {
  /** Tokens to overlap `profile_tokens` against. */
  tokens: string[];
  /** Rows the probe may return, cut by `last_coverage desc, id`. */
  limit: number;
}

/**
 * The candidate retrieval, as ONE decision — because the token array and the row
 * cap are a PAIR, and separating them is the failure this function exists to
 * make impossible.
 *
 * `narrowed: true` probes with the anchor-eligible subset and caps at 4,000.
 * `false` probes with the whole profile and caps at 200. Those are the only two
 * combinations, they are returned from one object literal each, and neither half
 * can be obtained without the other. That matters more than it looks:
 *
 *  - the subset is a proven NECESSARY CONDITION (`anchorEligibleTokens`), so it
 *    is safe *because* nothing that would qualify is unreachable through it;
 *  - 4,000 is safe *because* it is a census of the narrowed probe's row counts —
 *    it binds on 0 of 12,366 groups narrowed, and the broad probe's p50 is 1,903
 *    rows with a max of 8,054.
 *
 * So whole profile + 4,000 is not "the old behaviour with a roomier valve", it is
 * the broad probe with its only bound effectively removed: a wider qualifier set
 * than either mode, feeding an O(n²) `bridgePairs` cross-product, in a loop that
 * is self-reinforcing because `mergeStorylines` re-points a merge loser's bridges
 * onto the winner. More percolation-prone than the old behaviour AND than the new
 * one. If you are here to simplify this, the two branches are the simplification;
 * splitting the flag into two knobs re-opens exactly that state.
 *
 * `STORYLINE_NARROW_RETRIEVAL` chooses the mode, and `storyline-replay.ts` reads
 * the same flag through this same function — the correspondence between service
 * and replay is what pins every threshold in docs/STORYLINE-LINKING.md, and its
 * silent loss is the root of §2.5.
 */
export function candidateRetrieval(
  groupTokens: readonly string[],
  corpus: Corpus,
  rules: LinkRules,
  narrowed: boolean,
): CandidateRetrieval {
  return narrowed
    ? {
        tokens: anchorEligibleTokens(groupTokens, corpus, rules),
        limit: NARROWED_CANDIDATE_LIMIT,
      }
    : { tokens: [...groupTokens], limit: WHOLE_PROFILE_CANDIDATE_LIMIT };
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
 * retrieval overlaps against — and this is duplicated rather than shared because
 * the sweep has no database: replaying a month of decisions through SQL would
 * take longer than the corpus it measures, and a threshold nobody can afford to
 * sweep is a threshold that ships unmeasured.
 *
 * **The two do NOT agree, and this comment used to claim they must.** Storage
 * counts a group as carrying a token if ANY of its articles does
 * (`select distinct mg.group_id, tok`); the input here is `groupProfile`, which
 * requires a MAJORITY of the group's articles. The two coincide for a group of
 * one article — most groups — and diverge above that. Measured on the dev
 * archive: over the 722 live single-group storylines whose group holds two or
 * more articles, stored profiles average 21.9 tokens against the majority rule's
 * 20.2, and 104 of the 722 differ. So production's storyline profiles are
 * systematically WIDER than what any replay predicts, which widens overlap,
 * qualifiers and `bridgePairs`' cross-product with them.
 *
 * Left as it is on purpose, and the direction of the error is why: closing it
 * changes every number the committed threshold grid was pinned against, so it
 * needs its own measurement rather than a quiet edit
 * (docs/STORYLINE-LINKING.md, "Two things this contradicts").
 *
 * `minGroupSupport` is the floor under that majority, and it DEFAULTS TO 2
 * because the majority alone degenerates at two members: `Math.ceil(n / 2)` is
 * 1 when n is 2, so a two-group storyline's profile was the UNION of its
 * members' vocabularies rather than their consensus. The second group donated
 * everything it said to the arc's identity, and the third group was then judged
 * against a profile no two members had agreed on. At 2 the rule reads as the
 * INTERSECTION there, and it is unchanged from three members up, where the
 * majority already demands 2 — so this moves exactly one member count.
 *
 * MEASURED before it shipped, over 62 days of the dev archive (35,178 articles,
 * 28,723 groups) at the deployed share=0.002 / mass=20 / K=2, by
 * `pnpm measure:storylines-v2 --variant=min-support:1` for the old rule against
 * an unqualified run for this one:
 *
 *   | rule            | chained arcs | named-intact  | groups kept | merges |
 *   |-----------------|--------------|---------------|-------------|--------|
 *   | support >= 1    | 350  (7.4%)  | 1473  (30.1%) | 54.0%       | 606    |
 *   | support >= 2    |  45  (0.7%)  |  901  (18.4%) | 48.3%       | 339    |
 *
 * A "chained" arc holds two member groups sharing NO token — it cannot have
 * been built by those two linking, so something percolated. That is the failure
 * this buys down, and the worked example is prod storyline
 * 49002d0e ("Antigonish Ambulance Theft"), where a stolen-ambulance report and
 * eight EPA power-plant articles shared nothing at all: one CBC piece about
 * natural gas plants in a Nova Scotia county overlapped the ambulance on
 * `{nova, scotia, county, ultimately}` and the EPA coverage on `{natural, gas,
 * power, plant}`, and the union-at-two handed its whole vocabulary to the arc.
 * Under this rule that arc's profile is those four Nova Scotia tokens, the EPA
 * group shares none of them, and no threshold can admit it.
 *
 * The cost is real and is not hidden: 572 judged-real arcs stop reassembling
 * exactly. It is bought anyway because the same precision purchased through the
 * mass floor costs MORE — share=0.002/mass=25 leaves 101 chained arcs with only
 * 793 named arcs intact and 43.3% of groups kept, which this beats on all three.
 *
 * `refreshProfileTokens` in storage applies the same floor in SQL, and the two
 * must move together. 1 prices the old rule, which is what the sweep's
 * `--variant=min-support:1` is for.
 */
export function storylineProfile(
  groupTokens: readonly (readonly string[])[],
  minGroupSupport = 2,
): string[] {
  // The pre-2026-09-14 rule, reached by the same call it always was so a run
  // pricing it cannot drift: `groupProfile` keeps its own single-member
  // shortcut, whose output is not sorted, and nothing here re-derives it.
  if (minGroupSupport <= 1) return groupProfile(groupTokens);
  const need = Math.max(
    Math.ceil(groupTokens.length / 2),
    // Clamped to the member count, because a storyline of ONE must keep its own
    // vocabulary: `profile_tokens` is what candidate retrieval overlaps against,
    // so an empty profile is not a stricter storyline, it is a storyline no
    // group can ever find. Formation would stop outright rather than tighten.
    Math.min(minGroupSupport, groupTokens.length),
  );
  return tokensWithSupport(groupTokens, need);
}

/** Tokens at least `need` of these members carry, sorted. */
function tokensWithSupport(
  memberTokens: readonly (readonly string[])[],
  need: number,
): string[] {
  const support = new Map<string, number>();
  for (const tokens of memberTokens) {
    for (const token of new Set(tokens)) support.set(token, (support.get(token) ?? 0) + 1);
  }
  const profile: string[] = [];
  for (const [token, count] of support) if (count >= need) profile.push(token);
  return profile.sort();
}

/**
 * The prefix of a group's qualifiers that may BRIDGE — `undefined` is all of
 * them, which is what shipped.
 *
 * One function rather than a `slice` at each call site, because there are two:
 * `bridgePairs` below, and the linker's report of what it bridged. Those two
 * disagreeing would be a report that lies about the write beside it, which is
 * the cheapest possible version of the bug this whole file's history is about.
 *
 * **The input must already be in `qualifyingStorylines`' order** — mass
 * descending, then the older storyline, then the id. That is a defined total
 * order with a defined tiebreak, picked so a replay reproduces the run it
 * replays; taking a prefix inherits it, and re-sorting here would invent a
 * second one to keep in step.
 */
export function bridgingQualifiers<T>(
  qualified: readonly T[],
  maxQualifiers: number | undefined,
): readonly T[] {
  if (maxQualifiers === undefined) return qualified;
  return qualified.slice(0, Math.max(0, maxQualifiers));
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
 *
 * **`maxQualifiers` is the bound on the cross-product, and this is the only
 * place it may be applied.** Unbounded this is O(n²) in the qualifier count —
 * a 40-qualifier group writes 780 pairs — and the pair count is what feeds the
 * feedback loop: more pairs reach K, each merge unions two profiles,
 * `mergeStorylines` re-points the loser's bridges onto the winner rather than
 * dropping them, and a wider profile overlaps more on the next arrival. Bounding
 * here removes the quadratic term at source; raising K instead raises the bar
 * every merge must clear, including the repairs ADR-0011 refuses to build a
 * split for. `undefined` is unbounded, which is the behaviour that shipped.
 *
 * **The bound is applied to the pairing, NOT to `qualifyingStorylines`.** That
 * function returns every qualifier deliberately — the ATTACH picks the best of
 * them, and the retroactive path picks the best the group is not already in — so
 * narrowing it there would cost linking as well as evidence. Bounded here, the
 * group still joins exactly the arc it would have joined; all it loses is the
 * right to testify about pairs it ranks low for.
 *
 * The bound is a prefix of `qualifyingStorylines`' order and inherits its
 * tiebreak — see `bridgingQualifiers`, which is where the prefix is taken so
 * this and the linker's report of it cannot disagree. Any `maxQualifiers` at or
 * above the qualifier count is the unbounded result, so the bound is inert until
 * it binds: on the live archive that is 26% of bridging groups with the
 * retrieval narrowed and 0.5% without it.
 */
export function bridgePairs(
  // Only the ids are read: the caller may hold full qualifications or the
  // thinner record a replay keeps, and neither should have to be widened to
  // satisfy the other. Ordered as `qualifyingStorylines` returns them — see
  // above; `maxQualifiers` takes a prefix and therefore inherits that tiebreak.
  qualified: readonly { candidate: { id: string } }[],
  maxQualifiers?: number,
): [string, string][] {
  const ids = bridgingQualifiers(qualified, maxQualifiers).map((q) => q.candidate.id);
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
