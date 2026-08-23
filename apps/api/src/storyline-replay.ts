import {
  bridgePairs,
  candidateRetrieval,
  groupProfile,
  qualifyingStorylines,
  storylineProfile,
  type Corpus,
  type LinkCandidate,
  type LinkRules,
} from "./storyline-link.js";

/**
 * The linker, replayed in memory (ADR-0011: "no threshold ships unmeasured").
 *
 * This is not a second implementation of the decision — `qualifyingStorylines`,
 * `groupProfile`, `storylineProfile` and `bridgePairs` are the same functions
 * `storyline-linker.ts` calls. What is reimplemented is the STORAGE the
 * decision runs against: candidate retrieval becomes an inverted index instead
 * of a GIN scan, and attach/merge become map surgery instead of SQL. That
 * substitution is the whole point. A sweep of a dozen threshold combinations
 * over a month of live corpus is thousands of decisions per combination, and
 * through the database it would take longer to measure a threshold than to
 * regret it.
 *
 * The replay is chronological because the linker is order-dependent and replay
 * order is the canonical order (ADR-0011's Rollout, and the discipline regroup
 * already lives by).
 */

export interface ReplayGroup {
  groupId: string;
  /** Story tokens per member article. */
  memberTokens: readonly (readonly string[])[];
  language: string | null;
  publishedMs: number;
  /** APP_TIMEZONE day key — what a storyline-day slot is bucketed by. */
  dayKey: string;
}

interface ReplayStoryline {
  id: string;
  /** Member groups' profiles, in attach order — the profile's input. */
  groupProfiles: string[][];
  groupIds: string[];
  profileTokens: string[];
  lastCoverageMs: number;
  days: Set<string>;
  promoted: boolean;
}

export interface ReplayResult {
  storylines: number;
  /** Storylines holding more than one group: the ones that are REAL. */
  promoted: number;
  /** Groups that joined an existing storyline rather than seeding one. */
  attached: number;
  merges: number;
  /** Groups in the biggest storyline — the percolation alarm (ADR-0011). */
  largestStoryline: number;
  /** …as a share of all groups. The 1,179-of-1,190 swallow was 99%. */
  largestShare: number;
  /** Storyline-day slots: what the reader actually pages over. */
  daySlots: number;
  /** Size distribution over promoted storylines. */
  p50: number;
  p99: number;
  /**
   * Groups whose candidate set was LARGER than the configured row cap — i.e.
   * where the service's `limit` would have truncated the decision this replay
   * just certified, and the replay did not.
   *
   * Reported rather than applied, and the distinction is the whole of §2.5 in
   * docs/VERCEL-PHASE-0-FINDINGS.md: the replay has never modelled the cut, so
   * for months the thresholds below were pinned against an uncapped candidate set
   * while production ran a capped one, and nothing in the output said so. It says
   * so now. Non-zero means this grid does not describe what the service will do;
   * narrowed it is measured at 0 over the dev archive's whole window, which is
   * the only reason a limit there and none here is a difference without a
   * consequence.
   */
  cappedGroups: number;
  /**
   * The storylines themselves, biggest first — profile and member groups.
   * A sweep table cannot say whether a storyline is COHERENT; only reading
   * some can, and a threshold pinned off counts alone is pinned off half the
   * evidence.
   */
  built: { profile: string[]; groupIds: string[]; days: number }[];
}

/**
 * Replay every group through the linker's decision, in publication order.
 *
 * `corpusAt` supplies the trailing corpus as it stood when the group arrived —
 * the sweep slides a real 14-day window over `story_token_days` rather than
 * measuring every decision against today's corpus, because a threshold tuned
 * against a corpus the linker will never see is not measured, it is guessed.
 *
 * `narrowRetrieval` is `STORYLINE_NARROW_RETRIEVAL`, and it is a REQUIRED
 * argument rather than a defaulted one: the replay must model whichever mode is
 * configured, because a threshold is only pinned against the candidate set
 * production will actually judge, and a default here is how the two quietly come
 * apart again.
 */
export function replayLinker(
  groups: readonly ReplayGroup[],
  corpusAt: (group: ReplayGroup, tokens: readonly string[]) => Corpus,
  rules: LinkRules,
  mergeBridges: number,
  narrowRetrieval: boolean,
): ReplayResult {
  const storylines = new Map<string, ReplayStoryline>();
  /** token → storyline ids carrying it: the in-memory stand-in for the GIN index. */
  const byToken = new Map<string, Set<string>>();
  /** canonical pair key → distinct groups that bridged it. */
  const bridges = new Map<string, Set<string>>();
  /** alias → survivor, so a merged id keeps resolving. */
  const alias = new Map<string, string>();

  let attached = 0;
  let merges = 0;
  let nextId = 0;
  let cappedGroups = 0;

  const resolve = (id: string): string => {
    let current = id;
    for (let hop = 0; hop < 32 && alias.has(current); hop += 1) current = alias.get(current)!;
    return current;
  };

  const index = (storyline: ReplayStoryline): void => {
    for (const token of storyline.profileTokens) {
      const ids = byToken.get(token);
      if (ids) ids.add(storyline.id);
      else byToken.set(token, new Set([storyline.id]));
    }
  };
  const deindex = (storyline: ReplayStoryline): void => {
    for (const token of storyline.profileTokens) byToken.get(token)?.delete(storyline.id);
  };

  /** Re-derive both derivations after any membership change, as storage does. */
  const refresh = (storyline: ReplayStoryline): void => {
    deindex(storyline);
    storyline.profileTokens = storylineProfile(storyline.groupProfiles);
    index(storyline);
  };

  for (const group of [...groups].sort(
    (a, b) => a.publishedMs - b.publishedMs || (a.groupId < b.groupId ? -1 : 1),
  )) {
    const profile = groupProfile(group.memberTokens);

    // Birth: every group seeds a provisional storyline of one.
    nextId += 1;
    const own: ReplayStoryline = {
      id: `s${nextId}`,
      groupProfiles: [profile],
      groupIds: [group.groupId],
      profileTokens: [...profile],
      lastCoverageMs: group.publishedMs,
      days: new Set([group.dayKey]),
      promoted: false,
    };
    storylines.set(own.id, own);
    index(own);
    if (profile.length === 0) continue;

    const corpus = corpusAt(group, profile);
    if (corpus.size === 0) continue;

    // Candidate retrieval, and it must be the SERVICE's retrieval, because a
    // threshold is only pinned against the candidate set production will
    // actually judge. That is not a free-standing remark: this comment used to
    // say the loop below was "exactly what `profile_tokens && story_tokens`
    // returns", which was true of the predicate and silent about the
    // `limit 200` the service added on top — so every threshold in
    // `config/src/index.ts` was certified against an uncapped candidate set
    // while production ran a capped one, on 99% of groups. The divergence was
    // invisible for exactly as long as both comments sounded right.
    //
    // So the probe tokens come from `candidateRetrieval`, the same call
    // `linkGroup` makes, with the same flag: narrowed, this is the
    // anchor-eligible subset and provably a no-op on the RESULT (the filter is a
    // necessary condition, and `storyline-link.test.ts` asserts it); broad, it is
    // the whole profile, exactly the retrieval every number in
    // docs/STORYLINE-LINKING.md was measured against.
    //
    // The row cap is the half this harness still does not APPLY, and it says so
    // out loud instead: `cappedGroups` counts the groups where the service's
    // limit would have cut the candidate set the grid below certifies. Narrowed,
    // that count is 0 over the whole dev window by census, so no limit here and
    // 4,000 there is a difference without a consequence. Broad, it is the known
    // divergence §2.5 records — the grid is the uncapped one the thresholds were
    // pinned on, and production cuts at 200 — which is a fact about the pre-#117
    // behaviour the flag restores, not something this replay may quietly repair
    // by applying a cut the thresholds were never certified under.
    const retrieval = candidateRetrieval(profile, corpus, rules, narrowRetrieval);
    const candidateIds = new Set<string>();
    for (const token of retrieval.tokens) {
      for (const id of byToken.get(token) ?? []) {
        if (id !== own.id) candidateIds.add(id);
      }
    }
    if (candidateIds.size > retrieval.limit) cappedGroups += 1;

    const candidates: LinkCandidate[] = [];
    for (const id of candidateIds) {
      const storyline = storylines.get(id);
      if (!storyline) continue;
      candidates.push({
        id,
        profileTokens: storyline.profileTokens,
        lastCoverageMs: storyline.lastCoverageMs,
        groupCount: storyline.groupProfiles.length,
      });
    }

    const qualified = qualifyingStorylines(
      profile,
      candidates,
      corpus,
      rules,
      group.publishedMs,
    );
    if (qualified.length === 0) continue;

    // Absorb the birth storyline into the best qualifier — the group leaves
    // its own arc rather than belonging to two, exactly as the service does.
    const winner = storylines.get(qualified[0]!.candidate.id)!;
    deindex(own);
    storylines.delete(own.id);
    alias.set(own.id, winner.id);
    winner.groupProfiles.push(profile);
    winner.groupIds.push(group.groupId);
    winner.lastCoverageMs = Math.max(winner.lastCoverageMs, group.publishedMs);
    winner.days.add(group.dayKey);
    winner.promoted = true;
    refresh(winner);
    attached += 1;

    // Bridges among the qualifiers; K distinct groups merge a pair.
    for (const [a, b] of bridgePairs(qualified)) {
      const left = resolve(a);
      const right = resolve(b);
      if (left === right) continue;
      const key = left < right ? `${left}|${right}` : `${right}|${left}`;
      const groupsBridging = bridges.get(key) ?? new Set<string>();
      groupsBridging.add(group.groupId);
      bridges.set(key, groupsBridging);
      if (groupsBridging.size < mergeBridges) continue;

      const one = storylines.get(left);
      const two = storylines.get(right);
      if (!one || !two) continue;
      const [keep, drop] =
        one.groupProfiles.length >= two.groupProfiles.length ? [one, two] : [two, one];
      deindex(drop);
      storylines.delete(drop.id);
      alias.set(drop.id, keep.id);
      keep.groupProfiles.push(...drop.groupProfiles);
      keep.groupIds.push(...drop.groupIds);
      keep.lastCoverageMs = Math.max(keep.lastCoverageMs, drop.lastCoverageMs);
      for (const day of drop.days) keep.days.add(day);
      keep.promoted = true;
      refresh(keep);
      bridges.delete(key);
      merges += 1;
    }
  }

  const sizes: number[] = [];
  let largest = 0;
  let promoted = 0;
  let daySlots = 0;
  for (const storyline of storylines.values()) {
    const size = storyline.groupProfiles.length;
    daySlots += storyline.days.size;
    if (size > 1) {
      promoted += 1;
      sizes.push(size);
    }
    if (size > largest) largest = size;
  }

  const built = [...storylines.values()]
    .filter((storyline) => storyline.groupIds.length > 1)
    .sort((a, b) => b.groupIds.length - a.groupIds.length)
    .map((storyline) => ({
      profile: storyline.profileTokens,
      groupIds: storyline.groupIds,
      days: storyline.days.size,
    }));
  sizes.sort((a, b) => a - b);
  const at = (q: number): number => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))] ?? 0;

  return {
    storylines: storylines.size,
    promoted,
    attached,
    merges,
    largestStoryline: largest,
    largestShare: groups.length > 0 ? largest / groups.length : 0,
    daySlots,
    p50: at(0.5),
    p99: at(0.99),
    cappedGroups,
    built,
  };
}
