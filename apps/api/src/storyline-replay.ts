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
 *
 * ## Birth offers, and re-offers
 *
 * `replayLinker` walks each group exactly ONCE, which models the birth path and
 * nothing else. That was the whole harness for as long as the nightly
 * late-candidate sweep looked like a cost problem rather than a decision, and it
 * is why the pinned K survived a bug it should have caught: the sweep re-offers
 * every group in the trailing window every night, `bridgePairs` is the full
 * O(n²) cross-product over a group's qualifiers, and a merge widens the
 * surviving profile so the NEXT pass retrieves more. A feedback loop across
 * passes, invisible to a harness with one pass (VERCEL-PHASE-0-FINDINGS §2.6).
 *
 * `replayWithReoffers` is that harness's missing half, and it is deliberately
 * the same `offerGroup` the birth path calls — one definition of the decision,
 * for the reason `wiring.ts` gives about the two processes that make it. A
 * forked simulator that drifts from the service is how the cap was able to
 * truncate the decision for months while both comments sounded right.
 */

export interface ReplayGroup {
  groupId: string;
  /** Story tokens per member article. */
  memberTokens: readonly (readonly string[])[];
  language: string | null;
  publishedMs: number;
  /** APP_TIMEZONE day key — what a storyline-day slot is bucketed by. */
  dayKey: string;
  /**
   * One domain standing for the group's coverage, for the independence
   * variants below. An APPROXIMATION and named as one: grouping already folds
   * a syndicated story's copies into one group, so a group usually has one
   * domain, but where it has several this keeps the first alphabetically rather
   * than letting one group count as several sources.
   */
  sourceDomain: string;
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
  /**
   * Does this arc carry vocabulary assembled under the pre-#117 cap?
   *
   * True for an arc seeded while `cappedRetrievalLimit` was set, and it SPREADS
   * on merge (`keep || drop`) rather than being decided by the survivor: the
   * point of the flag is that the arc's `profile_tokens` are the majority
   * vocabulary of a cap-shaped membership, and absorbing a cap-shaped arc puts
   * that vocabulary into the survivor's profile too.
   *
   * Only `replayHybrid` sets it meaningfully — everywhere else the build phase
   * either does not exist or is the whole run — and it exists to attribute
   * merges: §2.7's hybrid is specifically the fusion of arcs the cap created,
   * and "the merges happened" cannot distinguish that from ordinary linking.
   */
  capShaped: boolean;
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
   *
   * `ReplayFidelity.cappedRetrievalLimit` is the one exception, and it is a
   * separate knob for that reason: it APPLIES a cut, deliberately, to build an
   * archive the way the capped service built the live one.
   */
  cappedGroups: number;
  /**
   * Groups pulled into an ADDITIONAL arc by a re-offer, rather than moved out
   * of a birth storyline (`linkGroup`'s retroactive-attachment path). Always 0
   * for a birth-only replay, which is what makes it the sweep's own yield.
   */
  retroAttached: number;
  /**
   * Live pairs holding at least one bridge, and total (pair, group)
   * observations — `storyline_bridges` rows. Reported separately because they
   * answer different questions: the pair count is how much of the graph is
   * one merge away from joining, the observation count is how much evidence
   * re-offers have manufactured.
   */
  bridgedPairs: number;
  bridgeObservations: number;
  /**
   * Merges made AFTER the retrieval switch that fused two arcs both carrying
   * cap-shaped vocabulary — §2.7's hybrid, counted rather than inferred.
   *
   * This is the measurement that separates "the corrected retrieval merges a
   * lot" from "the corrected retrieval fuses fragments the cap created", which
   * are the two readings §2.7 could not choose between. A from-scratch replay
   * cannot produce one of these by construction — nothing in it is cap-shaped —
   * so a non-zero count here is content no from-scratch run holds, and a zero
   * count refutes §2.7's mechanism rather than merely failing to find it.
   *
   * 0 outside `replayHybrid`, which is the only mode with an "after" to be in.
   */
  fusedCapShaped: number;
  /**
   * Merges after the switch where exactly one side was cap-shaped, and where
   * neither was. Together with `fusedCapShaped` they partition the post-switch
   * merges, so the three can be read as shares.
   */
  fusedMixed: number;
  fusedFresh: number;
  /**
   * Groups arriving after the switch that attached to a cap-shaped arc — the
   * benign half of the same question. An attach is not a merge: it grows one
   * arc by one group and cannot chain, so a hybrid whose post-switch effect is
   * mostly attachment is the "repairs" reading, and one whose effect is
   * `fusedCapShaped` is the "widening past the certified bar" reading.
   */
  attachedToCapShaped: number;
  /**
   * Arc sizes as a histogram, because a largest-arc metric alone is not
   * evidence: it can hold while the count of live storylines collapses, and
   * §2.6's runaway showed up in "four arcs over 100 groups where there was one"
   * a pass before the maximum moved.
   */
  sizeBuckets: { label: string; count: number }[];
  p90: number;
  /**
   * The storylines themselves, biggest first — profile and member groups.
   * A sweep table cannot say whether a storyline is COHERENT; only reading
   * some can, and a threshold pinned off counts alone is pinned off half the
   * evidence.
   */
  built: { profile: string[]; groupIds: string[]; days: number; capShaped: boolean }[];
}

/**
 * What the replay is allowed to model beyond the committed birth-only harness.
 *
 * `cascadeMerges` is a FIDELITY knob, not a tuning one. `mergeStorylines`
 * re-points the loser's bridges onto the winner, so a third storyline holding
 * one bridge to each side reaches K with no insert to trigger a check — which
 * is why `cascadeMerge` exists in the service and why `readBridgedPairs` found
 * 31 stranded pairs in the dev archive. This harness has never modelled either:
 * on a merge it drops the merged pair's evidence and leaves every other pair
 * keyed under the alias, where the next `resolve` cannot find it. Off by
 * default so the committed threshold grid keeps reproducing the numbers it was
 * pinned against; the effect of turning it on is measured rather than assumed
 * (docs/STORYLINE-LINKING.md).
 */
export interface ReplayFidelity {
  cascadeMerges?: boolean;
  /**
   * Retrieve candidates the way the service did BEFORE PR #117: probe with the
   * whole group profile and keep the `limit` most recently covered, rather than
   * probing with the anchor-eligible subset.
   *
   * The probe half of that is now what `STORYLINE_NARROW_RETRIEVAL=false`
   * already selects; what this knob adds is the half nothing else does, which is
   * APPLYING the cut. Everywhere else the cap is reported and not applied
   * (`ReplayResult.cappedGroups`), for the reason recorded there.
   *
   * This exists to answer the one question a from-scratch replay cannot: the
   * live archive was BUILT under the 200-row whole-profile cap, so its arcs
   * carry cap-shaped profiles and a backlog of links the thresholds already
   * certify but the retrieval could never find. §2.6's runaway was measured by turning
   * the corrected sweep loose on exactly that state. Building the replay's
   * archive this way and then sweeping it corrected is the same experiment, and
   * it is what separates "re-offers percolate" from "draining a cap-built
   * backlog percolates" — two diagnoses with different fixes.
   */
  cappedRetrievalLimit?: number;
}

/**
 * The four candidate answers to the runaway, as knobs on one instrument.
 *
 * Raising K is only the first of them and it is the bluntest: K is the bar
 * EVERY merge must clear, including the repairs ADR-0011 refuses to build a
 * split for. The other three attack the loop where it is generated instead —
 * the quadratic pair count, what "independent" is allowed to mean, and whether
 * a re-offer may manufacture evidence at all. Defaults reproduce today's
 * behaviour exactly, so a run with no variant set is the baseline.
 */
export interface ReplayVariant {
  /**
   * Option 2: at most this many of a group's qualifiers may bridge, taken best
   * mass first. `bridgePairs` is the full O(n²) cross-product, so a group with
   * 40 qualifiers writes 780 pairs; bounding the qualifier list bounds the pair
   * count at the source rather than raising the bar every pair must clear. The
   * ATTACH is untouched — the group still joins its best qualifier — so this
   * costs no linking, only evidence.
   *
   * **This is the same argument `bridgePairs` takes on the write path**
   * (`STORYLINE_MAX_BRIDGING_QUALIFIERS`, via `LinkerConfig`), applied by the
   * same function rather than modelled by a second one. It stays on
   * `ReplayVariant` because a measurement must be able to price a bound the
   * configuration does not have — that is what the option table is — and
   * `storyline-sweep-cli.ts` defaults it from the flag so an unqualified run
   * still describes the deployed mode.
   */
  maxBridgingQualifiers?: number;
  /**
   * Option 3: what makes two bridges independent. `groups` is today's rule and
   * counts distinct group ids. `days` and `domains` additionally require the
   * bridging groups to span K distinct publication days, or K distinct source
   * domains — the reading of "independent evidence" that a single day's
   * syndicated coverage cannot satisfy on its own.
   */
  independence?: "groups" | "days" | "domains";
  /**
   * Option 4: which offers may record bridge evidence. `first` records only on
   * a group's first offer — bridge at birth, while still letting the sweep
   * ATTACH — which removes the cross-pass feedback loop entirely and keeps the
   * sweep's retroactive-attachment value.
   */
  bridgeOffers?: "all" | "first";
}

/** One group's bridge observation, carrying what independence may be read from. */
interface BridgeMark {
  day: string;
  domain: string;
}

interface World {
  readonly rules: LinkRules;
  readonly mergeBridges: number;
  /**
   * `STORYLINE_NARROW_RETRIEVAL`, threaded through rather than defaulted — the
   * replay must model whichever retrieval is configured, because a threshold is
   * only pinned against the candidate set production will actually judge, and a
   * default here is how the two quietly came apart before (PR #128).
   */
  readonly narrowRetrieval: boolean;
  readonly cascadeMerges: boolean;
  readonly variant: Required<Pick<ReplayVariant, "independence" | "bridgeOffers">> &
    Pick<ReplayVariant, "maxBridgingQualifiers">;
  /**
   * Set while an archive is being BUILT under the pre-#117 retrieval and
   * cleared before the sweep passes run against it — see
   * `ReplayFidelity.cappedRetrievalLimit`. Mutable because it is a phase of one
   * run, not a property of the configuration.
   */
  cappedRetrievalLimit: number | undefined;
  /**
   * Which side of the retrieval switch this offer is on. `build` is the archive
   * being assembled the way the capped service assembled the live one; `after`
   * is every offer once the flag has flipped. Only `replayHybrid` ever moves it,
   * and the attribution counters below are only written in `after` — a merge
   * during the build phase is the cap's own fragmentation being measured, not
   * the hybrid's fusion.
   */
  phase: "build" | "after";
  storylines: Map<string, ReplayStoryline>;
  /** token → storyline ids carrying it: the in-memory stand-in for the GIN index. */
  byToken: Map<string, Set<string>>;
  /** canonical pair key → the groups that bridged it, and what each one was. */
  bridges: Map<string, Map<string, BridgeMark>>;
  /** alias → survivor, so a merged id keeps resolving. */
  alias: Map<string, string>;
  /**
   * groupId → the storylines it belongs to, earliest attach first. This is
   * `readGroupStorylines`, and the order is load-bearing: `linkGroup` reads
   * `existing[0]` as the group's OWN storyline, and the count of groups in that
   * one is what decides between the fresh path and the re-offer path.
   */
  homes: Map<string, string[]>;
  attached: number;
  retroAttached: number;
  merges: number;
  nextId: number;
  cappedGroups: number;
  fusedCapShaped: number;
  fusedMixed: number;
  fusedFresh: number;
  attachedToCapShaped: number;
}

const createWorld = (
  rules: LinkRules,
  mergeBridges: number,
  narrowRetrieval: boolean,
  fidelity: ReplayFidelity,
  variant: ReplayVariant,
): World => ({
  rules,
  mergeBridges,
  narrowRetrieval,
  cascadeMerges: fidelity.cascadeMerges ?? false,
  cappedRetrievalLimit: fidelity.cappedRetrievalLimit,
  phase: "build",
  variant: {
    independence: variant.independence ?? "groups",
    bridgeOffers: variant.bridgeOffers ?? "all",
    ...(variant.maxBridgingQualifiers !== undefined
      ? { maxBridgingQualifiers: variant.maxBridgingQualifiers }
      : {}),
  },
  storylines: new Map(),
  byToken: new Map(),
  bridges: new Map(),
  alias: new Map(),
  homes: new Map(),
  attached: 0,
  retroAttached: 0,
  merges: 0,
  nextId: 0,
  cappedGroups: 0,
  fusedCapShaped: 0,
  fusedMixed: 0,
  fusedFresh: 0,
  attachedToCapShaped: 0,
});

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const resolve = (world: World, id: string): string => {
  let current = id;
  for (let hop = 0; hop < 32 && world.alias.has(current); hop += 1) {
    current = world.alias.get(current)!;
  }
  return current;
};

const index = (world: World, storyline: ReplayStoryline): void => {
  for (const token of storyline.profileTokens) {
    const ids = world.byToken.get(token);
    if (ids) ids.add(storyline.id);
    else world.byToken.set(token, new Set([storyline.id]));
  }
};

const deindex = (world: World, storyline: ReplayStoryline): void => {
  for (const token of storyline.profileTokens) world.byToken.get(token)?.delete(storyline.id);
};

/** Re-derive both derivations after any membership change, as storage does. */
const refresh = (world: World, storyline: ReplayStoryline): void => {
  deindex(world, storyline);
  storyline.profileTokens = storylineProfile(storyline.groupProfiles);
  index(world, storyline);
};

/** One group joins one arc: `attachGroup`, plus the re-derivation it runs. */
const addGroupTo = (
  world: World,
  storyline: ReplayStoryline,
  group: ReplayGroup,
  profile: string[],
): void => {
  storyline.groupProfiles.push(profile);
  storyline.groupIds.push(group.groupId);
  storyline.lastCoverageMs = Math.max(storyline.lastCoverageMs, group.publishedMs);
  storyline.days.add(group.dayKey);
  storyline.promoted = true;
  refresh(world, storyline);
};

/**
 * Merge a pair, and return the third storylines whose evidence just moved —
 * `MergeResult.repointed`. Under the committed semantics the loser's other
 * bridges are simply abandoned at a key nothing resolves to again; under
 * `cascadeMerges` they follow the survivor, which is what storage does.
 */
const mergePair = (world: World, left: string, right: string): string[] => {
  const one = world.storylines.get(left);
  const two = world.storylines.get(right);
  if (!one || !two) return [];

  // "More coverage wins", so the surviving id is the one more readers hold
  // (`pickWinner`).
  const [keep, drop] =
    one.groupProfiles.length >= two.groupProfiles.length ? [one, two] : [two, one];

  // Attribute the merge before the two become one, and only after the switch —
  // §2.7's question is not "how many merges" but "how many of them fuse arcs
  // the cap created", and after the merge there is one arc and no pair to
  // classify.
  if (world.phase === "after") {
    if (keep.capShaped && drop.capShaped) world.fusedCapShaped += 1;
    else if (keep.capShaped || drop.capShaped) world.fusedMixed += 1;
    else world.fusedFresh += 1;
  }

  const repointed: string[] = [];
  if (world.cascadeMerges) {
    for (const [key, groups] of [...world.bridges]) {
      const [lo, hi] = key.split("|") as [string, string];
      if (lo !== drop.id && hi !== drop.id) continue;
      world.bridges.delete(key);
      const other = lo === drop.id ? hi : lo;
      // A pair that is now one storyline has nothing left to bridge, and
      // keeping it would let a healed merge count toward the next one.
      if (other === keep.id) continue;
      const moved = pairKey(keep.id, other);
      const existing = world.bridges.get(moved);
      if (existing) for (const [groupId, mark] of groups) existing.set(groupId, mark);
      else world.bridges.set(moved, new Map(groups));
      repointed.push(other);
    }
  }

  deindex(world, drop);
  world.storylines.delete(drop.id);
  world.alias.set(drop.id, keep.id);
  // Storage inserts the loser's memberships
  // `on conflict (storyline_id, group_id) do nothing`, so a group that belongs
  // to BOTH sides is counted once. Concatenating the two lists counts it twice,
  // and it is not a rounding error: `snapshot` reads arc size off
  // `groupProfiles.length`, so a duplicate inflates `largestStoryline` and
  // `largestShare` directly — the tell being a share above 100% — and the
  // duplicated profile votes twice in `storylineProfile`'s majority rule, which
  // widens the survivor, which widens retrieval on the next offer.
  //
  // Reachable only through the re-offer path's one retroactive arc, so it could
  // not happen in a birth-only replay and every birth-only number is unaffected.
  // `groupProfiles` and `groupIds` are parallel arrays and must be skipped in
  // lockstep.
  const held = new Set(keep.groupIds);
  for (let i = 0; i < drop.groupIds.length; i += 1) {
    const groupId = drop.groupIds[i]!;
    if (held.has(groupId)) continue;
    held.add(groupId);
    keep.groupIds.push(groupId);
    keep.groupProfiles.push(drop.groupProfiles[i]!);
  }
  keep.lastCoverageMs = Math.max(keep.lastCoverageMs, drop.lastCoverageMs);
  for (const day of drop.days) keep.days.add(day);
  keep.promoted = true;
  // Cap-shaped vocabulary is now in the survivor's profile, so the survivor is
  // cap-shaped: `storylineProfile` is a majority rule over member group
  // profiles, and the loser's members are the survivor's members now.
  keep.capShaped = keep.capShaped || drop.capShaped;
  refresh(world, keep);
  world.bridges.delete(pairKey(left, right));
  world.merges += 1;
  return repointed;
};

/**
 * Record a bridge for every pair among the qualifiers, and merge any pair K
 * independent groups have now bridged — `recordBridgesAmong`, and when
 * `cascadeMerges` is on, the `cascadeMerge` drain behind it.
 */
/**
 * Is this pair's evidence now K INDEPENDENT observations?
 *
 * `groups` is ADR-0011's rule as built: K distinct group ids. The other two
 * keep that requirement and add one — the same K bridges must also come from K
 * distinct days, or K distinct source domains — because "distinct groups" is
 * satisfiable by one afternoon of coverage of one event, which is the weakest
 * possible reading of "independent evidence".
 */
const independentEnough = (world: World, marks: Map<string, BridgeMark>): boolean => {
  if (marks.size < world.mergeBridges) return false;
  if (world.variant.independence === "groups") return true;
  const distinct = new Set<string>();
  for (const mark of marks.values()) {
    distinct.add(world.variant.independence === "days" ? mark.day : mark.domain);
  }
  return distinct.size >= world.mergeBridges;
};

const recordBridgesAmong = (
  world: World,
  qualified: readonly { candidate: { id: string } }[],
  group: ReplayGroup,
): void => {
  // The bound is `bridgePairs`' own argument now, not a slice here — the service
  // applies it in the same call, so the two cannot drift the way the retrieval
  // did (PR #128). `maxBridgingQualifiers` reaches this from
  // `STORYLINE_MAX_BRIDGING_QUALIFIERS` by default and from `--variant=cap:N`
  // when a measurement overrides it.
  for (const [a, b] of bridgePairs(qualified, world.variant.maxBridgingQualifiers)) {
    const left = resolve(world, a);
    const right = resolve(world, b);
    if (left === right) continue;
    const key = pairKey(left, right);
    const groupsBridging = world.bridges.get(key) ?? new Map<string, BridgeMark>();
    groupsBridging.set(group.groupId, { day: group.dayKey, domain: group.sourceDomain });
    world.bridges.set(key, groupsBridging);
    if (!independentEnough(world, groupsBridging)) continue;

    const repointed = mergePair(world, left, right);
    if (!world.cascadeMerges) continue;

    // Everything whose evidence just moved onto the survivor, re-asked against
    // K. Bounded exactly as `CASCADE_LIMIT` bounds the service: a run that hits
    // the bound has left the invariant unmet, which is a fact about the
    // configuration rather than something to loop over.
    const pending = repointed.map((other) => pairKey(resolve(world, left), other));
    const queued = new Set(pending);
    for (let step = 0; pending.length > 0 && step < 32; step += 1) {
      const next = pending.shift()!;
      const [lo, hi] = next.split("|") as [string, string];
      const survivor = resolve(world, lo);
      const other = resolve(world, hi);
      if (survivor === other) continue;
      const held = world.bridges.get(pairKey(survivor, other));
      if (!held || !independentEnough(world, held)) continue;
      for (const moved of mergePair(world, survivor, other)) {
        const pairing = pairKey(resolve(world, survivor), moved);
        if (queued.has(pairing)) continue;
        queued.add(pairing);
        pending.push(pairing);
      }
    }
  }
};

/**
 * One group offered to the linker — `linkGroup`, in memory.
 *
 * Called for a group's birth and for every re-offer, because that is how the
 * service works: `linkGroup` has no notion of which offer this is, only of
 * whether the group's own storyline still holds nothing but the group. Keeping
 * one function for both is the point — the sweep's job is to ask the SAME
 * question later, and a harness with a separate re-offer routine could not tell
 * a threshold problem from a divergence between its two routines.
 */
const offerGroup = (world: World, group: ReplayGroup, corpus: Corpus): void => {
  const profile = groupProfile(group.memberTokens);

  let homes = world.homes.get(group.groupId);
  const firstOffer = homes === undefined;
  if (homes === undefined) {
    // Birth: every group seeds a provisional storyline of one.
    world.nextId += 1;
    const own: ReplayStoryline = {
      id: `s${world.nextId}`,
      groupProfiles: [profile],
      groupIds: [group.groupId],
      profileTokens: [...profile],
      lastCoverageMs: group.publishedMs,
      days: new Set([group.dayKey]),
      promoted: false,
      // Seeded while the cap was applied, so whatever it goes on to absorb it
      // absorbed through the truncated candidate set — which is what makes its
      // eventual profile cap-shaped rather than merely old.
      capShaped: world.cappedRetrievalLimit !== undefined,
    };
    world.storylines.set(own.id, own);
    index(world, own);
    homes = [own.id];
    world.homes.set(group.groupId, homes);
  }
  if (profile.length === 0) return;
  if (corpus.size === 0) return;

  // A merge may have moved a home since the last offer, so resolve before
  // reading `existing[0]`. Order is preserved: `readGroupStorylines` sorts by
  // `attached_at`, and a merge keeps the loser's groups' original timestamps.
  const resolvedHomes: string[] = [];
  for (const id of homes) {
    const target = resolve(world, id);
    if (!resolvedHomes.includes(target)) resolvedHomes.push(target);
  }
  homes.length = 0;
  homes.push(...resolvedHomes);

  const ownId = resolvedHomes[0]!;
  const own = world.storylines.get(ownId);
  if (own === undefined) return;

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
  // `linkGroup` makes, with the same flag: narrowed, this is the anchor-eligible
  // subset and provably a no-op on the RESULT (the filter is a necessary
  // condition, and `storyline-link.test.ts` asserts it); broad, it is the whole
  // profile, exactly the retrieval every number in docs/STORYLINE-LINKING.md was
  // measured against. `cappedRetrievalLimit` forces the broad half regardless,
  // because the probe and the cap are a PAIR (PR #128) and replaying "the
  // pre-#117 retrieval" means replaying both of it.
  //
  // The row cap is the half this harness still does not APPLY, and it says so
  // out loud instead: `cappedGroups` counts the groups where the service's limit
  // would have cut the candidate set this run certifies. Narrowed, that count is
  // 0 over the whole dev window by census. Broad, it is the known divergence
  // §2.5 records — a fact about the pre-#117 behaviour the flag restores, not
  // something this replay may quietly repair by applying a cut the thresholds
  // were never certified under. `cappedRetrievalLimit` is the one place a cut IS
  // applied, on purpose, and only for a build phase.
  //
  // Only `own` is excluded, exactly as the service excludes it: a SECOND arc
  // this group was pulled into is a legitimate candidate to re-qualify for, and
  // what stops that becoming a free merge is the `already` filter below.
  const capped = world.cappedRetrievalLimit;
  const retrieval = candidateRetrieval(
    profile,
    corpus,
    world.rules,
    capped === undefined ? world.narrowRetrieval : false,
  );
  const candidateIds = new Set<string>();
  for (const token of retrieval.tokens) {
    for (const id of world.byToken.get(token) ?? []) {
      if (id !== ownId) candidateIds.add(id);
    }
  }
  if (candidateIds.size > retrieval.limit) world.cappedGroups += 1;

  let candidates: LinkCandidate[] = [];
  for (const id of candidateIds) {
    const storyline = world.storylines.get(id);
    if (!storyline) continue;
    candidates.push({
      id,
      profileTokens: storyline.profileTokens,
      lastCoverageMs: storyline.lastCoverageMs,
      groupCount: storyline.groupProfiles.length,
    });
  }
  if (capped !== undefined && candidates.length > capped) {
    // `order by last_coverage desc nulls last, s.id limit $n` — the cut that
    // was documented as keeping "the storylines a group is most likely to
    // belong to" and was in fact discarding ~90% of the candidate set by
    // recency, which is not what the decision reads.
    candidates.sort(
      (a, b) => b.lastCoverageMs - a.lastCoverageMs || (a.id < b.id ? -1 : 1),
    );
    candidates = candidates.slice(0, capped);
  }

  const qualified = qualifyingStorylines(
    profile,
    candidates,
    corpus,
    world.rules,
    group.publishedMs,
  );
  if (qualified.length === 0) return;

  // Option 4: bridge at birth only. The ATTACH below still happens, so the
  // sweep keeps the retroactive attachment ADR-0011 promises and loses only its
  // ability to manufacture merge evidence a second time.
  const mayBridge = world.variant.bridgeOffers === "all" || firstOffer;

  if (own.groupIds.length > 1) {
    // A RE-OFFER of a group that already lives somewhere real. `linkGroup`
    // splits here on the same test — `ownGroups > 1` — and what it does on this
    // side is narrower than the fresh path in two ways that decide this whole
    // measurement:
    //
    //  - ONE retroactive arc, ever. `existing.length === 1` is the guard, so a
    //    group re-offered fourteen nights running cannot be walked into
    //    fourteen arcs.
    //  - bridges only from arcs the group is NOT a member of, so a multi-homed
    //    group cannot manufacture K "independent" bridges by re-qualifying for
    //    its own home night after night.
    //
    // `already` is read BEFORE the attach, exactly as the service reads it, so
    // an arc taken on this very offer still counts as bridge evidence.
    const already = new Set(resolvedHomes);
    if (resolvedHomes.length === 1) {
      const arc = qualified.find((q) => !already.has(q.candidate.id));
      const target = arc ? world.storylines.get(arc.candidate.id) : undefined;
      if (target) {
        addGroupTo(world, target, group, profile);
        homes.push(target.id);
        world.retroAttached += 1;
      }
    }
    if (mayBridge) {
      recordBridgesAmong(
        world,
        qualified.filter((q) => !already.has(q.candidate.id)),
        group,
      );
    }
    return;
  }

  // The group's own storyline still holds nothing but the group, so this is the
  // fresh decision — whether that is the group's birth or a late offer of a
  // group that never found an arc. Absorb the birth storyline into the best
  // qualifier: the group LEAVES its own arc rather than belonging to two,
  // exactly as `mergeStorylines(winner, own)` does.
  const winner = world.storylines.get(qualified[0]!.candidate.id)!;
  deindex(world, own);
  world.storylines.delete(own.id);
  world.alias.set(own.id, winner.id);
  if (world.phase === "after" && winner.capShaped) world.attachedToCapShaped += 1;
  addGroupTo(world, winner, group, profile);
  homes[0] = winner.id;
  world.attached += 1;

  if (mayBridge) recordBridgesAmong(world, qualified, group);
};

const BUCKETS: { label: string; min: number; max: number }[] = [
  { label: "2-4", min: 2, max: 4 },
  { label: "5-9", min: 5, max: 9 },
  { label: "10-19", min: 10, max: 19 },
  { label: "20-49", min: 20, max: 49 },
  { label: "50-99", min: 50, max: 99 },
  { label: "100+", min: 100, max: Number.POSITIVE_INFINITY },
];

const snapshot = (world: World, totalGroups: number): ReplayResult => {
  const sizes: number[] = [];
  let largest = 0;
  let promoted = 0;
  let daySlots = 0;
  for (const storyline of world.storylines.values()) {
    const size = storyline.groupProfiles.length;
    daySlots += storyline.days.size;
    if (size > 1) {
      promoted += 1;
      sizes.push(size);
    }
    if (size > largest) largest = size;
  }

  let bridgeObservations = 0;
  for (const marks of world.bridges.values()) bridgeObservations += marks.size;

  const built = [...world.storylines.values()]
    .filter((storyline) => storyline.groupIds.length > 1)
    .sort((a, b) => b.groupIds.length - a.groupIds.length)
    .map((storyline) => ({
      profile: storyline.profileTokens,
      groupIds: storyline.groupIds,
      days: storyline.days.size,
      capShaped: storyline.capShaped,
    }));
  sizes.sort((a, b) => a - b);
  const at = (q: number): number =>
    sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * q))] ?? 0;

  return {
    storylines: world.storylines.size,
    promoted,
    attached: world.attached,
    merges: world.merges,
    largestStoryline: largest,
    largestShare: totalGroups > 0 ? largest / totalGroups : 0,
    daySlots,
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    cappedGroups: world.cappedGroups,
    retroAttached: world.retroAttached,
    bridgedPairs: world.bridges.size,
    bridgeObservations,
    fusedCapShaped: world.fusedCapShaped,
    fusedMixed: world.fusedMixed,
    fusedFresh: world.fusedFresh,
    attachedToCapShaped: world.attachedToCapShaped,
    sizeBuckets: BUCKETS.map((bucket) => ({
      label: bucket.label,
      count: sizes.filter((size) => size >= bucket.min && size <= bucket.max).length,
    })),
    built,
  };
};

/** Publication order, and the id after it — the canonical replay order. */
const inOrder = (groups: readonly ReplayGroup[]): ReplayGroup[] =>
  [...groups].sort((a, b) => a.publishedMs - b.publishedMs || (a.groupId < b.groupId ? -1 : 1));

/**
 * Replay every group through the linker's decision, in publication order.
 *
 * Birth offers only: each group is offered exactly once, when it arrives. This
 * is the harness that pinned every threshold in `packages/config`, and it stays
 * the calibration — a change here must keep reproducing the committed grid
 * (docs/STORYLINE-LINKING.md).
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
  fidelity: ReplayFidelity = {},
  variant: ReplayVariant = {},
): ReplayResult {
  const world = createWorld(rules, mergeBridges, narrowRetrieval, fidelity, variant);
  for (const group of inOrder(groups)) {
    offerGroup(world, group, corpusAt(group, groupProfile(group.memberTokens)));
  }
  return snapshot(world, groups.length);
}

export interface ReofferOptions {
  /**
   * `interleaved` is what production runs: each simulated day's new groups are
   * offered, then ONE sweep pass runs over the trailing DF window. It models
   * the thing that actually matters and no other shape does — a group sits in
   * the window for `windowDays` nights, so it is re-offered ~14 times over its
   * life, against an archive that is growing underneath it.
   *
   * `posthoc` builds the archive birth-only and then runs `passes` sweeps over
   * the final window. It is cheaper, it is the shape §2.6 measured, and it is
   * NOT production: a converged post-hoc state need not equal the state
   * production reaches, because post-hoc re-offers every group in the window
   * the same number of times regardless of when it was published, and it never
   * lets a new day's coverage arrive between two passes.
   */
  mode: "interleaved" | "posthoc";
  /** The trailing DF window, in days — `STORYLINE_DF_WINDOW_DAYS`. */
  windowDays: number;
  /** Sweep passes. `posthoc` runs this many; `interleaved` runs one a night. */
  passes: number;
  fidelity?: ReplayFidelity;
  variant?: ReplayVariant;
  /**
   * Called after every sweep pass with the state as it then stood — the
   * per-pass trajectory. A single converged number cannot distinguish "settled"
   * from "still climbing when the run stopped", and §2.6's runaway was found in
   * the trajectory rather than in the endpoint.
   */
  onPass?: (pass: number, label: string, result: ReplayResult) => void;
}

/**
 * The replay, with the sweep's re-offers in it.
 *
 * What this models: `linkGroup` offered the same group again, against the
 * archive as it then stands, with the trailing corpus and dormancy clock still
 * taken from the GROUP's own publication time — which is what the sweep does,
 * since `runLateCandidateChore` passes `group.published` and not the night's
 * clock. Retroactive attachment, the one-arc guard, and bridges-from-non-member
 * arcs are all the service's, because they are `offerGroup`'s.
 *
 * What it does NOT model, and none of these is a detail:
 *  - the coherence gate. `STORYLINE_COHERENCE_GATE` withholds a formation
 *    between two singletons pending a model verdict, and no threshold
 *    measurement may spend model quota. So this replay forms every formation,
 *    which is the pre-gate behaviour and the LOOSER of the two.
 *  - a group's membership changing. Production re-aggregates `memberTokens` on
 *    every read, so an arriving article can widen the profile the linker
 *    judged; here a group's tokens are fixed at their final state.
 *  - retention. `story_token_days` is pruned in production, which moves a
 *    verdict with no storyline in the causal chain; the corpus here is the full
 *    archive's.
 *  - production's hybrid state. This builds from scratch, so every arc has a
 *    profile shaped by the current retrieval. The live archive was built under
 *    the 200-row cap and its arcs carry cap-shaped profiles.
 */
export function replayWithReoffers(
  groups: readonly ReplayGroup[],
  corpusAt: (group: ReplayGroup, tokens: readonly string[]) => Corpus,
  rules: LinkRules,
  mergeBridges: number,
  narrowRetrieval: boolean,
  options: ReofferOptions,
): ReplayResult {
  const world = createWorld(
    rules,
    mergeBridges,
    narrowRetrieval,
    options.fidelity ?? {},
    options.variant ?? {},
  );
  const ordered = inOrder(groups);
  // A group's profile is re-derived on every read in production, but the
  // replay's member tokens are fixed, so this is the same array every time and
  // an interleaved run asks for it ~14 times per group.
  const profiles = new Map<string, string[]>();
  const offer = (group: ReplayGroup): void => {
    let profile = profiles.get(group.groupId);
    if (profile === undefined) {
      profile = groupProfile(group.memberTokens);
      profiles.set(group.groupId, profile);
    }
    offerGroup(world, group, corpusAt(group, profile));
  };

  const dayMs = 86_400_000;
  /** The window's earliest publication instant for a night ending on `dayEndMs`. */
  const windowStart = (dayEndMs: number): number => dayEndMs - options.windowDays * dayMs;

  if (options.mode === "posthoc") {
    for (const group of ordered) offer(group);
    // The archive is built; the cap belongs to the build and not to the sweep.
    // Clearing it here is what makes this §2.6's experiment — a corrected sweep
    // turned loose on an archive the cap shaped — rather than either state on
    // its own.
    world.cappedRetrievalLimit = undefined;
    const lastMs = ordered.at(-1)?.publishedMs ?? 0;
    const from = windowStart(lastMs);
    const window = ordered.filter((group) => group.publishedMs >= from);
    for (let pass = 1; pass <= options.passes; pass += 1) {
      for (const group of window) offer(group);
      options.onPass?.(pass, `pass ${pass} (${window.length} offered)`, snapshot(world, groups.length));
    }
    return snapshot(world, groups.length);
  }

  // Interleaved has no distinct build phase to confine the cap to — a night's
  // births and its sweep run against the same state — so a half-capped run
  // would be a state neither the old service nor the new one ever reaches.
  if (world.cappedRetrievalLimit !== undefined) {
    throw new Error("cappedRetrievalLimit models a build phase; use mode `posthoc`");
  }

  // Interleaved. Day keys rather than raw timestamps, because a "night" is a
  // day boundary in APP_TIMEZONE and that is what `dayKey` already carries.
  const byDay = new Map<string, ReplayGroup[]>();
  for (const group of ordered) {
    const day = byDay.get(group.dayKey);
    if (day) day.push(group);
    else byDay.set(group.dayKey, [group]);
  }
  let night = 0;
  for (const [dayKey, born] of [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const group of born) offer(group);

    // The night's sweep: every group whose publication falls inside the
    // trailing window, in publication order — `readLinkableGroups` pages on
    // `(group_published, group_id)`, so this is its order too. The window ends
    // at the END of the day just ingested, since the chore runs after midnight.
    const dayEndMs = Date.parse(`${dayKey}T00:00:00Z`) + dayMs;
    const from = windowStart(dayEndMs);
    const window = ordered.filter(
      (group) => group.publishedMs >= from && group.publishedMs < dayEndMs,
    );
    for (const group of window) offer(group);
    night += 1;
    options.onPass?.(night, `night ${dayKey} (${window.length} offered)`, snapshot(world, groups.length));
  }
  return snapshot(world, groups.length);
}

/** A simulated day, as `replayHybrid` reports it. */
export interface HybridDay {
  dayKey: string;
  /**
   * `build` — offered under the pre-#117 retrieval, assembling the arc
   * population the capped service assembled. `after` — offered under the
   * configured retrieval, which is the flag being on.
   */
  phase: "build" | "after";
  /** Groups born on this day. Birth-only, so it is also the offers made. */
  born: number;
}

export interface HybridOptions {
  /**
   * The row cap the archive is BUILT under — production's 200. Omit it and the
   * build phase runs the configured retrieval too, which is the from-scratch
   * CONTROL: same days, same per-day snapshots, the archive assembled by the
   * decision that will judge it. That control is the whole point of the knob
   * being optional — §2.7's claim is about the difference between two starting
   * states, and a difference needs both of them measured on one instrument.
   */
  cappedRetrievalLimit?: number;
  /**
   * The first day judged by the corrected retrieval — an APP_TIMEZONE day key.
   * Days before it are the build; this day and after are the flag being on.
   *
   * A day key rather than a count of days, because the switch has to be
   * reproducible across runs whose corpus grew underneath them.
   */
  switchOn: string;
  fidelity?: Omit<ReplayFidelity, "cappedRetrievalLimit">;
  variant?: ReplayVariant;
  /**
   * Called after every simulated day, build days included. The build days are
   * not padding: they are where the cap's own fragmentation is visible, and a
   * post-switch climb means nothing without the pre-switch line it departs
   * from — §2.6's lesson, which is that this class of problem lives in the
   * trajectory and not in the endpoint.
   */
  onDay?: (day: HybridDay, result: ReplayResult) => void;
}

/**
 * The hybrid: an archive BUILT under the pre-#117 cap, then new arrivals judged
 * by the corrected retrieval — birth-only, one offer per group, no sweep.
 *
 * This is VERCEL-PHASE-0-FINDINGS §2.7 step 1, and it is the configuration
 * production would actually walk if `STORYLINE_NARROW_RETRIEVAL` were turned on
 * today: the live archive was assembled by the capped decision, all three
 * re-offer flags are off (`STORYLINE_LATE_CANDIDATE_SWEEP`,
 * `STORYLINE_REOFFER_JOINED_GROUPS`, and the sweep's changed-set filter), so
 * `linkSeededGroups` is the only path that offers a group and it offers it once.
 *
 * What this adds to `--capped-build=200` on `replayWithReoffers`, which prices
 * the same starting state under sweep RE-OFFERS: the corrected retrieval arrives
 * at the birth path's rate — a day's new groups, once each — rather than as
 * ~12,000 re-offers a night, and there are subsequent DAYS to watch it over.
 * Same `offerGroup`, so it is the same decision at a different rate, which is
 * the only way the two numbers are comparable at all.
 *
 * The cap and the broad probe move together and cannot come apart. With the
 * configured retrieval BROAD (`STORYLINE_NARROW_RETRIEVAL=false`, today's
 * default) the cap therefore stays applied across the switch, so that run is the
 * flag-off control rather than the whole-profile-probe-with-no-bound state §2.5
 * warns is worse than either mode. There is no argument to this function that
 * can reach that pair.
 *
 * What it does NOT model is everything `replayWithReoffers` lists, and one more
 * that matters most here: the build phase is the REPLAY's cap-built archive, not
 * production's. Production's carries label-agreement merges, coherence-gate
 * withholdings and storage's union-rule profiles, all three of which make its
 * starting state broader than this one. This measures the mechanism, and it
 * measures it from the narrower side.
 */
export function replayHybrid(
  groups: readonly ReplayGroup[],
  corpusAt: (group: ReplayGroup, tokens: readonly string[]) => Corpus,
  rules: LinkRules,
  mergeBridges: number,
  narrowRetrieval: boolean,
  options: HybridOptions,
): ReplayResult {
  const world = createWorld(
    rules,
    mergeBridges,
    narrowRetrieval,
    {
      ...(options.fidelity ?? {}),
      ...(options.cappedRetrievalLimit !== undefined
        ? { cappedRetrievalLimit: options.cappedRetrievalLimit }
        : {}),
    },
    options.variant ?? {},
  );

  const ordered = inOrder(groups);
  const byDay = new Map<string, ReplayGroup[]>();
  for (const group of ordered) {
    const day = byDay.get(group.dayKey);
    if (day) day.push(group);
    else byDay.set(group.dayKey, [group]);
  }

  for (const [dayKey, born] of [...byDay].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (dayKey >= options.switchOn) {
      world.phase = "after";
      // Narrowed, the cut goes: 4,000 binds on 0 of the window's groups by
      // census, and the replay reports the cap it does not apply. Broad, the cut
      // STAYS, because whole profile + 4,000 is the pair `candidateRetrieval`
      // exists to make unreachable.
      if (narrowRetrieval) world.cappedRetrievalLimit = undefined;
    }
    for (const group of born) {
      offerGroup(world, group, corpusAt(group, groupProfile(group.memberTokens)));
    }
    options.onDay?.(
      { dayKey, phase: world.phase, born: born.length },
      snapshot(world, groups.length),
    );
  }

  return snapshot(world, groups.length);
}
