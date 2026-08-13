import { contentTokens } from "./term-scoring.js";
import { singular } from "./grouping.js";

/**
 * Storyline linking (ADR-0009) — the loose layer ABOVE grouping.
 *
 * A group answers "are these two headlines the same piece, syndicated?" and
 * errs high, because a false merge hides an article behind a toggle
 * (ADR-0002). A STORYLINE answers a different question: "are these groups the
 * same day's coverage of one story?" — the retrospective, the successor
 * speculation and the fact-check that ARE the day's coverage of a resignation
 * without sharing its wording. §14.3 named that gap ("loose coverage with
 * almost no shared vocabulary") as the strongest case for vectors; this is the
 * lexical answer, and it can afford to be looser than grouping because a wrong
 * link is a stray item under a headline, never a merged slot.
 *
 * The decision is two-part, both measured before the defaults were pinned
 * (ADR-0009, the same posture ADR-0005 took):
 *
 *  - **an anchor**: the pair must share at least one RARE token — rare within
 *    the day's own corpus — because "white house press secretary" is shared by
 *    every White House story on a dense day and proves nothing, while
 *    "leavitt" names exactly one story. Rarity is day-relative: the anchor
 *    that works on a quiet Sunday must still work on a 1,100-article Wednesday.
 *  - **corroborating mass**: the summed rarity of EVERYTHING shared, so a
 *    single ambiguous name is not enough on its own and the description gets
 *    its say — an angle piece often carries the story's vocabulary only in its
 *    description ("As Karoline Leavitt plans to step down…" under a headline
 *    that never names her).
 *
 * Tokens come from title AND description — this layer exists precisely because
 * headlines of a storyline diverge — through the same tokenizer and stemmer as
 * grouping, so the two layers cannot disagree about what a word is.
 */

/**
 * The distinct, singularized content tokens of an article's title and
 * description together. The storyline analogue of `headlineTokens`, and
 * `story_tokens` in storage is a materialized derivation of exactly this.
 */
export function storyTokens(title: string, description: string | null): string[] {
  return [...new Set(contentTokens(`${title} ${description ?? ""}`).map(singular))];
}

export interface StorylineRules {
  /**
   * A shared token anchors a link only while its day-df stays at or below
   * this FRACTION of the day's corpus. Relative, not absolute, and the
   * measurement pass is why (ADR-0009): on the Leavitt day the story's own
   * name climbed to df 64 as coverage exploded — 4% of a 1,453-article day —
   * and an absolute cap of 25 stopped recognising the story exactly when it
   * became the day's biggest. A fraction keeps "names a story" meaning the
   * same thing on a quiet Sunday and a 1,400-article Wednesday; "trump", at
   * ~20% of any day, never qualifies under either reading.
   */
  anchorMaxShare: number;
  /**
   * Floor on the summed rarity of shared tokens (ln(dayN/df) each). The
   * anchor says "there is a name here"; the mass says "and the two articles
   * keep talking about the same thing around it".
   */
  massThreshold: number;
}

/**
 * Below this day-df a token anchors regardless of share. A 60-article corpus
 * makes 5% two articles — rarity carries no signal at that size, and the
 * floor keeps small days (off-peak languages, the day's first hours) able to
 * link at all.
 */
export const ANCHOR_DF_FLOOR = 10;

/** The share rule and its floor, in one place — every caller must agree. */
export function anchorCeiling(dayCorpusSize: number, rules: StorylineRules): number {
  return Math.max(ANCHOR_DF_FLOOR, dayCorpusSize * rules.anchorMaxShare);
}

/**
 * Document frequency over one day-corpus's token sets. Callers pass the sets
 * `storyTokens` produced — already distinct per article, so this counts
 * articles, never occurrences, the same discipline §10.3 applies to terms.
 */
export function storyDayDf(
  tokenSets: readonly (readonly string[])[],
): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of tokenSets) {
    for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  }
  return df;
}

/**
 * The evidence one pair of articles offers for being the same storyline:
 * the rarity-weighted mass of what they share, and the day-df of the rarest
 * shared token (Infinity when nothing is shared).
 *
 * Mass, not weighted Jaccard: a storyline pair is EXPECTED to differ — the
 * angle piece has its own paragraphs — so normalizing by the union would
 * punish exactly the pairs this layer exists to catch. What either side says
 * beyond the shared part is no evidence against the link.
 */
export function storylineEvidence(
  a: readonly string[],
  b: readonly string[],
  df: ReadonlyMap<string, number>,
  dayCorpusSize: number,
): { mass: number; anchorDf: number } {
  const right = new Set(b);
  let mass = 0;
  let anchorDf = Number.POSITIVE_INFINITY;

  for (const token of new Set(a)) {
    if (!right.has(token)) continue;
    // A token the df map has not seen scores as df 1: the caller's corpus and
    // the pair's tokens should be the same data, but a drifted map must read
    // as "rare", which fails soft into a slightly over-eager link — this
    // layer's cheap direction.
    const d = Math.max(1, df.get(token) ?? 1);
    mass += Math.log(Math.max(1, dayCorpusSize / d));
    if (d < anchorDf) anchorDf = d;
  }

  return { mass, anchorDf };
}

/** The storyline decision for one pair, under the given rules. */
export function linksStoryline(
  a: readonly string[],
  b: readonly string[],
  df: ReadonlyMap<string, number>,
  dayCorpusSize: number,
  rules: StorylineRules,
): boolean {
  const { mass, anchorDf } = storylineEvidence(a, b, df, dayCorpusSize);
  return anchorDf <= anchorCeiling(dayCorpusSize, rules) && mass >= rules.massThreshold;
}

/** One group, as the clustering sees it: its members' story tokens and the
 * facts its processing order is derived from. */
export interface StorylineGroup {
  id: string;
  /** Story tokens per member — link evidence is max over cross-member pairs,
   * the same any-member rule grouping candidates use (ADR-0005). */
  memberTokens: readonly (readonly string[])[];
  /** MIN(published) over members, as epoch ms — the deterministic tiebreak. */
  publishedMs: number;
}

/**
 * Cluster one day-corpus's groups into storylines: hub-and-spoke, never
 * transitive. Returns groupId → hub groupId (self for a hub).
 *
 * The first cut of this layer unioned every qualifying pair transitively, and
 * the measurement pass (ADR-0009) killed it: on a live 1,100-article day the
 * chains percolated until ONE storyline held 1,179 of the day's 1,190 groups —
 * roundup articles whose descriptions name a dozen stories bridge everything
 * they mention. So membership here is one hop from the hub, on the same
 * reasoning `adoptStragglers` gives for refusing transitive group merges: a
 * spoke never extends a storyline's reach, so a roundup can JOIN a story but
 * can never fuse two stories.
 *
 * Hubs are chosen biggest-first (then earliest, then lowest id): the group
 * with the day's widest syndication is the story's centre of gravity, and the
 * ordering makes a replay deterministic — same corpus, same storylines
 * (§7.4's replayed-batch discipline).
 */
export function clusterStorylines(
  groups: readonly StorylineGroup[],
  df: ReadonlyMap<string, number>,
  dayCorpusSize: number,
  rules: StorylineRules,
): Map<string, string> {
  const ordered = [...groups].sort(
    (a, b) =>
      b.memberTokens.length - a.memberTokens.length ||
      a.publishedMs - b.publishedMs ||
      (BigInt(a.id) < BigInt(b.id) ? -1 : 1),
  );
  const profiles = new Map(
    ordered.map((group) => [group.id, groupProfile(group.memberTokens)]),
  );

  const hubs: StorylineGroup[] = [];
  const assignment = new Map<string, string>();

  const ceiling = anchorCeiling(dayCorpusSize, rules);
  for (const group of ordered) {
    const profile = profiles.get(group.id)!;
    let best: { hub: StorylineGroup; mass: number } | null = null;
    for (const hub of hubs) {
      const evidence = storylineEvidence(profile, profiles.get(hub.id)!, df, dayCorpusSize);
      if (evidence.anchorDf > ceiling || evidence.mass < rules.massThreshold) continue;
      if (!best || evidence.mass > best.mass) best = { hub, mass: evidence.mass };
    }
    if (best) {
      assignment.set(group.id, best.hub.id);
    } else {
      hubs.push(group);
      assignment.set(group.id, group.id);
    }
  }

  return assignment;
}

/**
 * What a GROUP says, as opposed to what any one member says: the tokens at
 * least half its members carry.
 *
 * Max-over-member-pairs was the first cut here, on ADR-0005's any-member
 * precedent, and the measurement pass killed it too: the Leavitt day's core
 * group contains four AP "The Latest:" live-blog copies whose descriptions
 * enumerate the whole day's news, and through those four members the story
 * acquired BLACKPINK, Thyssenkrupp and a blood-robot swarm as "coverage" —
 * every story the blog mentioned could bridge in. Majority support silences
 * vocabulary only a minority of members carry, which is exactly what a
 * live-blog's roundup material is; for a group of one (every angle piece),
 * the profile is simply its own tokens.
 */
export function groupProfile(
  memberTokens: readonly (readonly string[])[],
): string[] {
  if (memberTokens.length === 1) return [...memberTokens[0]!];
  const need = Math.ceil(memberTokens.length / 2);
  const support = new Map<string, number>();
  for (const tokens of memberTokens) {
    for (const token of tokens) support.set(token, (support.get(token) ?? 0) + 1);
  }
  const profile: string[] = [];
  for (const [token, count] of support) {
    if (count >= need) profile.push(token);
  }
  return profile;
}
