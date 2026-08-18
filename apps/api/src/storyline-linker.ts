import type { Kysely } from "kysely";
import {
  attachGroup,
  countBridges,
  createProvisionalStoryline,
  mergeStorylines,
  promoteStoryline,
  readBridgedPairs,
  readCandidateStorylines,
  readFormationRefusals,
  readGroupStorylines,
  readSoleGroup,
  recordBridge,
  resolveStoryline,
  type Database,
} from "@zammy/storage";
import { readTrailingCorpus, type StoryDfConfig } from "./story-df.js";
import {
  bridgePairs,
  groupProfile,
  qualifyingStorylines,
  type LinkRules,
  type LinkCandidate,
} from "./storyline-link.js";

/**
 * The linker, wired up (ADR-0011): every newly-seeded group is offered to the
 * storylines it might belong to, and takes one of its own when none fit.
 *
 * The shape of a decision, once per group:
 *
 *  1. **birth** — the group seeds a provisional storyline of one. The
 *     seed-own-identity discipline the old insert trigger enforced, generalized
 *     to the group layer, and what makes a provisional storyline-of-one the
 *     ordinary timeline slot rather than a special case the read path must know
 *     about.
 *  2. **retrieve** — candidates by GIN overlap against `profile_tokens`. One
 *     index scan; no day corpus, no unbounded read.
 *  3. **decide** — anchor + mass against the trailing corpus, dormancy gating
 *     the bar. Pure, in `storyline-link.ts`.
 *  4. **attach** to the best qualifier, and promote it if this is the group
 *     that made it real.
 *  5. **bridge** — every OTHER pair among the qualifiers is recorded, and a
 *     pair with K independent bridges merges. Merging on one bridge is refused:
 *     the 1,179-group swallow was transitive linking, and one ambiguous roundup
 *     chaining three storylines together is the same percolation delivered more
 *     slowly.
 *
 * Retroactive attachment rides this exact path — an old group is a candidate
 * arriving late, and nothing here reads the clock except dormancy, which reads
 * the storyline's last coverage rather than "now" against a creation date. What
 * makes it happen at all is step 4 running for an ALREADY-HOMED group too: it
 * keeps its home and gains the arc, which is the one case `attachGroup` exists
 * for. The nightly late-candidate sweep is what offers old groups again.
 *
 * Never throws. A linking failure must not fail the read that triggered the
 * ingest, for the reason grouping never throws: the articles are stored and
 * already paged, and the worst case is a group standing alone until the next
 * backfill offers it again.
 */

export interface LinkerConfig {
  /** ADR-0011's write path, behind a flag until the backfill is verified. */
  enabled: boolean;
  rules: LinkRules;
  /** K: independent bridges required to merge a pair. Starts at 2. */
  mergeBridges: number;
  storyDf: StoryDfConfig;
  /** The calendar storyline days are bucketed by (§10.1). */
  timeZone: string;
  /**
   * Withhold a FORMATION until a coherence verdict has seen it (ADR-0011's
   * amendment). False restores the pre-gate behaviour exactly: the merge happens
   * here, synchronously, and the label is asked for afterwards.
   *
   * The caller decides, because whether a gate exists is not the linker's
   * business: the server sets this only when a model is actually configured, and
   * the backfill sets it false because replaying the archive through the gate is
   * thousands of calls against a 500-a-day ceiling.
   */
  coherenceGate: boolean;
}

export interface LinkerDeps {
  db: Kysely<Database>;
  config: LinkerConfig;
  log?: { warn: (obj: object, msg: string) => void };
}

/**
 * Safety valve for a pathological token, not a tuning knob — the same argument
 * grouping's `CANDIDATE_LIMIT` makes. A group carrying a word half the archive
 * shares would otherwise make one decision an unbounded scan; taking the most
 * recently-covered N yields a worse link, never a wrong row.
 */
const CANDIDATE_LIMIT = 200;

/**
 * Merges one arrival's cascade may perform before it gives up and leaves the
 * rest to the sweep. A safety valve, not a tuning knob: each step is paid for by
 * K independent bridges, so a long chain is legitimate evidence — but an
 * ingest-path decision that merges without bound is one slow request and an
 * unreadable log, and `runBridgeSweep` finishes the job off the latency path.
 */
const CASCADE_LIMIT = 32;

/** One group, as the linker needs to see it. */
export interface LinkableGroup {
  groupId: string;
  /** Story tokens per member — the group's profile is the majority of these. */
  memberTokens: readonly (readonly string[])[];
  language: string | null;
  /** The group's earliest article: when this coverage happened. */
  published: Date;
}

export interface LinkOutcome {
  groupId: string;
  storylineId: string;
  /** True when the group joined an existing storyline rather than seeding one. */
  attached: boolean;
  /**
   * Arcs an ALREADY-HOMED group joined on this offer: retroactive attachment
   * (ADR-0011 — "a Wednesday storyline may pull in Monday's group").
   *
   * Separate from `attached`, which is about the group finding its home. This is
   * the group gaining an additional membership without leaving the first, and it
   * is a fact about the storylines that GREW rather than about where the group
   * lives — which is why the ids are here rather than replacing `storylineId`.
   */
  attachedTo: string[];
  /**
   * Storylines this offer made REAL — provisional until this group's arrival
   * gave them a second group. The labeler's promotion trigger fires on exactly
   * these; `attached` alone cannot carry it, because the 30th group joining an
   * established arc sets `attached` too, and firing a promotion label on every
   * join is model spend scaling with attach volume rather than with promotions.
   */
  promoted: string[];
  /** Storylines this group also qualified for — bridge evidence. */
  bridged: string[];
  /** Pairs this arrival's bridge pushed over K. */
  merged: { winnerId: string; loserId: string }[];
  /**
   * A formation this arrival EARNED on the token evidence and did not perform,
   * because `coherenceGate` is on and both sides are still singletons (ADR-0011's
   * amendment; docs/STORYLINE-LINKING.md, "The verdict, measured").
   *
   * The group is still alone in `storylineId` and nothing has been promoted. The
   * async tail (`resolvePendingFormations`) asks a model whether the two are one
   * story and then performs this merge, or records a refusal and leaves them
   * apart. Deferring rather than reverting is the whole point: the fresh path
   * absorbs a birth storyline by merge-WITH-ALIAS, so a promotion undone is the
   * split ADR-0011 refuses to build, and the way not to need a split is never to
   * create the state.
   *
   * A verdict that never arrives — a dead process, an exhausted quota — loses the
   * formation, not the coverage. Both groups keep their own storylines and the
   * nightly late-candidate sweep offers them again.
   */
  pendingFormation?: { winnerId: string; groupId: string; partnerGroupId: string };
}

/**
 * Link a batch of newly-seeded groups. One entry point, because a batch is what
 * the ingest path has: an upstream call creates ~8 articles, and the storyline
 * decision is per GROUP, not per article.
 *
 * Groups are processed in publication order so a replay of the same batch makes
 * the same decisions (§7.4). Within the batch, each group sees the writes of the
 * ones before it — the second group of a batch must be able to join the
 * storyline the first just seeded, or a syndicated pair arriving together would
 * never find each other.
 */
export async function linkSeededGroups(
  deps: LinkerDeps,
  groups: readonly LinkableGroup[],
): Promise<LinkOutcome[]> {
  if (!deps.config.enabled || groups.length === 0) return [];

  const ordered = [...groups].sort(
    (a, b) =>
      a.published.getTime() - b.published.getTime() ||
      (BigInt(a.groupId) < BigInt(b.groupId) ? -1 : 1),
  );

  const outcomes: LinkOutcome[] = [];
  for (const group of ordered) {
    try {
      outcomes.push(await linkGroup(deps, group));
    } catch (error) {
      deps.log?.warn(
        { err: error, groupId: group.groupId },
        "storyline linking failed for one group; it leads its own storyline",
      );
    }
  }
  return outcomes;
}

/**
 * One group's decision, written. Exported because the backfill (S5) replays
 * exactly this — a second implementation of the decision would be a second set
 * of rules to keep in step.
 */
export async function linkGroup(
  deps: LinkerDeps,
  group: LinkableGroup,
): Promise<LinkOutcome> {
  const profile = groupProfile(group.memberTokens);
  const zoned = { timeZone: deps.config.timeZone };

  // Already linked — a replayed batch, or the backfill re-reaching a group.
  // The birth is what makes this idempotent: a group always has a storyline,
  // so "have I seen this group" is a question the join table answers.
  const existing = await readGroupStorylines(deps.db, group.groupId);
  const own =
    existing[0] ??
    (await createProvisionalStoryline(deps.db, { groupId: group.groupId, ...zoned })).id;

  const outcome: LinkOutcome = {
    groupId: group.groupId,
    storylineId: own,
    attached: false,
    attachedTo: [],
    promoted: [],
    bridged: [],
    merged: [],
  };
  if (profile.length === 0) return outcome;

  const corpus = await readTrailingCorpus(
    { db: deps.db, config: deps.config.storyDf },
    { language: group.language, now: group.published, tokens: profile },
  );
  // An empty corpus means the window holds nothing yet — a fresh database, or
  // the first article of a language. Every token would read as maximally rare
  // and every candidate would qualify, which is the percolation this design
  // exists to refuse. The group keeps its own storyline and the next arrival,
  // with a corpus behind it, gets the real decision.
  if (corpus.size === 0) return outcome;

  let candidates = (
    await readCandidateStorylines(deps.db, { tokens: profile, limit: CANDIDATE_LIMIT })
  ).filter((candidate) => candidate.id !== own);

  // A formation a coherence verdict already refused is not offered again. Read
  // once, before the choice, so the group takes its best NON-refused candidate
  // rather than being handed its best and then blocked — a group refused at its
  // best candidate should land where the evidence puts it next, not nowhere.
  //
  // Only storylines-of-one are filtered, because that is all a refusal is about:
  // it says these two singletons are not a story between them, not that one may
  // never join the other's arc once that arc is real and wide. The gate is
  // measurably wrong about mature coverage, so its verdicts do not reach there.
  if (deps.config.coherenceGate && candidates.some((candidate) => candidate.groupCount === 1)) {
    const refused = await readFormationRefusals(deps.db, group.groupId);
    if (refused.size > 0) {
      const keep: typeof candidates = [];
      for (const candidate of candidates) {
        if (candidate.groupCount !== 1) {
          keep.push(candidate);
          continue;
        }
        const sole = await readSoleGroup(deps.db, candidate.id);
        if (sole === null || !refused.has(sole)) keep.push(candidate);
      }
      candidates = keep;
    }
  }

  const qualified = qualifyingStorylines(
    profile,
    candidates.map(
      (candidate): LinkCandidate => ({
        id: candidate.id,
        profileTokens: candidate.profileTokens,
        lastCoverageMs: candidate.lastCoverage.getTime(),
        groupCount: candidate.groupCount,
      }),
    ),
    corpus,
    deps.config.rules,
    group.published.getTime(),
  );
  if (qualified.length === 0) return outcome;

  // Attach to the best, and promote it: this group is the second, so the
  // storyline is real now. `attachGroup` refuses to infer that itself — a
  // backfill attaches in an order where the promoting arrival is not always
  // the second row written — so the observation is made here, where the
  // group count that justified it was read.
  const best = qualified[0]!;

  // Is `own` still a birth storyline — this group and nothing else? If the
  // group already shares a storyline with others, it has been linked before
  // and this is a replay: the bridges below are idempotent and still worth
  // recording, but re-homing it is not. Absorbing a REAL storyline into
  // another because one of its members would also fit there is a merge with no
  // bridge evidence at all, which is exactly the percolation K exists to
  // prevent — the first version of this did that, and the replay test caught
  // it. Pulling an already-homed group into an ADDITIONAL arc is retroactive
  // attachment, and it happens right here — see below.
  const ownGroups = await deps.db
    .selectFrom("storyline_groups")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("storyline_id", "=", own)
    .executeTakeFirst();
  if (Number(ownGroups?.n ?? 0) > 1) {
    // RETROACTIVE ATTACHMENT (ADR-0011: "a Wednesday storyline may pull in
    // Monday's group"; the plan: "an old group is just a candidate arriving
    // late"). The group has a home and keeps it; what it gains is a second arc
    // it independently qualifies for, which is the duplication ADR-0011 accepts
    // and the case `attachGroup` was built for.
    //
    // ONE retroactive arc, ever — the home it has, plus the best arc that
    // formed after it. That is what "a candidate arriving late" means: a late
    // arrival on the fresh path attaches to exactly one best arc, so the
    // late-offered group gets the same and no more. A group that keeps
    // qualifying for further storylines is bridge evidence about THOSE
    // (recorded below), and the design's answer to multi-fit is a merge —
    // a nightly sweep re-offering the same fortnight would otherwise walk a
    // four-qualifier group into all four arcs in four nights, which is
    // percolation with extra steps.
    const already = new Set(existing);
    const arc = existing.length === 1
      ? qualified.find((q) => !already.has(q.candidate.id))
      : undefined;
    if (arc) {
      const { attached } = await attachGroup(deps.db, {
        storylineId: arc.candidate.id,
        groupId: group.groupId,
        ...zoned,
      });
      if (attached) {
        outcome.attachedTo.push(arc.candidate.id);
        // This attach may be the arc's SECOND group — the fact that makes a
        // storyline real. The fresh path observes promotion where the group
        // count was read, and so does this one; without it a provisional that
        // grew retroactively would stay invisible to surfacing, labelling, and
        // the dormancy sweep forever.
        if (arc.candidate.groupCount === 1) {
          await promoteStoryline(deps.db, { storylineId: arc.candidate.id });
          outcome.promoted.push(arc.candidate.id);
        }
      }
    }

    // Bridge evidence only from arcs the group is NOT a member of. A member's
    // qualification for its own arc is the trivial fit `own` is excluded for on
    // the fresh path — its tokens are already in that profile — and counting it
    // would let one multi-homed group manufacture K "independent" bridges by
    // re-qualifying for itself night after night.
    const evidence = qualified.filter((q) => !already.has(q.candidate.id));
    outcome.bridged = evidence.map((q) => q.candidate.id);
    await recordBridgesAmong(deps, evidence, group.groupId, outcome);
    return outcome;
  }

  // The group LEAVES its birth storyline rather than joining a second one, and
  // merge-with-alias is how: a provisional storyline-of-one whose only group
  // has found its arc holds nothing, and leaving it standing would render the
  // group twice — once in its own plain slot, once in the storyline's. The
  // alias is why this is a merge and not a delete: the UUID may already be in
  // a reader's URL, and ADR-0011 is explicit that nothing holding one may
  // dangle. `attachGroup` stays the primitive for the other case — an old
  // group pulled into an ADDITIONAL arc, which is where the duplication
  // ADR-0011 accepts actually comes from.
  // THE GATE. When both sides are still singletons this attach would not merely
  // grow a storyline, it would CREATE one — the moment the coincidence piles come
  // from, and the only moment a coherence verdict is accurate enough to consult
  // (docs/STORYLINE-LINKING.md: 85.2% of declined piles caught at two groups, and
  // 43% of mature arcs wrongly refused). So the merge is withheld, not undone:
  // `mergeStorylines` leaves the loser as an ALIAS, and un-aliasing it is the
  // split ADR-0011 refuses to build.
  //
  // Bridges below are recorded either way. "This group qualified for both of
  // these" is a fact about those storylines whatever happens to this formation.
  if (deps.config.coherenceGate && best.candidate.groupCount === 1) {
    const partnerGroupId = await readSoleGroup(deps.db, best.candidate.id);
    // Null means the candidate gained a group since retrieval — a concurrent
    // arrival got there first. It is no longer a formation, so it is no longer
    // the gate's business and the merge below proceeds.
    if (partnerGroupId !== null) {
      outcome.pendingFormation = {
        winnerId: best.candidate.id,
        groupId: group.groupId,
        partnerGroupId,
      };
      outcome.bridged = qualified.slice(1).map((q) => q.candidate.id);
      await recordBridgesAmong(deps, qualified, group.groupId, outcome);
      return outcome;
    }
  }

  const absorbed = await mergeStorylines(deps.db, {
    winnerId: best.candidate.id,
    loserId: own,
    ...zoned,
  });
  outcome.storylineId = absorbed.winnerId ?? best.candidate.id;
  outcome.attached = absorbed.merged;

  // Real now: a second group attached. Observed here rather than inferred by
  // storage, because a backfill attaches in an order where the promoting
  // arrival is not always the second row written. `promoted` is recorded only
  // when the winner WAS a provisional-of-one — that is the moment a storyline
  // becomes visible and earns its promotion label; the 30th join re-runs the
  // idempotent status write but is not a promotion to announce.
  if (absorbed.merged) {
    await promoteStoryline(deps.db, { storylineId: outcome.storylineId });
    if (best.candidate.groupCount === 1) outcome.promoted.push(outcome.storylineId);
  }

  // Bridges among the qualifiers — a group that fits two established arcs is
  // evidence about those two arcs, whichever one it ended up in. The group's
  // own birth storyline takes no part: it is not something the group
  // qualified FOR, and a pair no second group can ever repeat is not
  // independent evidence of anything.
  outcome.bridged = qualified.slice(1).map((q) => q.candidate.id);
  await recordBridgesAmong(deps, qualified, group.groupId, outcome);

  return outcome;
}

/**
 * Record a bridge for every pair among the qualifiers, and merge any pair that
 * has now been bridged by K independent groups.
 *
 * Shared by the fresh and the replayed path because the evidence is the same
 * fact either way: this group qualified for both of these storylines. What
 * differs between the two paths is only where the group ends up living.
 */
async function recordBridgesAmong(
  deps: LinkerDeps,
  qualified: readonly { candidate: { id: string } }[],
  groupId: string,
  outcome: LinkOutcome,
): Promise<void> {
  for (const [a, b] of bridgePairs(qualified)) {
    const { recorded, pair } = await recordBridge(deps.db, {
      storylineA: a,
      storylineB: b,
      groupId,
    });
    if (!recorded || pair === null) continue;

    // The RESOLVED pair, not (a, b): an earlier iteration of this same loop may
    // have merged one of them away, and the row above was written under the
    // survivor's id. Counting under the stale id returns zero and silently skips
    // a merge that was due.
    const [lo, hi] = pair;
    if (
      (await countBridges(deps.db, { storylineA: lo, storylineB: hi })) <
      deps.config.mergeBridges
    ) {
      continue;
    }
    await cascadeMerge(deps, lo, hi, outcome);
  }
}

/**
 * Merge a pair, then drain the pairs that merge left at or above K.
 *
 * A merge moves the loser's bridges onto the winner (`mergeStorylines`), so a
 * third storyline that had one bridge to each side now has two to the survivor
 * — K, reached without a single bridge being recorded, and the linker's K check
 * only ever fires on an INSERT. That gap is not hypothetical: the dev archive
 * held 31 pairs at or above K that no future insert would have revisited, every
 * one involving a storyline that had absorbed merges.
 *
 * This is NOT the transitive linking ADR-0009 refused. Every merge here is still
 * paid for by K INDEPENDENT groups bridging that exact pair; what the cascade
 * fixes is that the evidence was already on the table and nobody read it. The
 * bound below is a safety valve for a pathological chain, not a rule — a run
 * that hits it has left the invariant unmet, so it says so rather than looping.
 */
async function cascadeMerge(
  deps: LinkerDeps,
  lo: string,
  hi: string,
  outcome: LinkOutcome,
): Promise<void> {
  const pending: [string, string][] = [[lo, hi]];
  // Pairs already QUEUED this cascade, so one pair is merged once. A pair that
  // fell short is deliberately NOT remembered: a later merge in this same
  // cascade re-points more bridges onto the same survivor, and a pair that
  // counted K-1 two hops ago can be at K now. Memoizing the shortfall is what
  // left those pairs for the nightly sweep to repair a day late; the cost of
  // dropping the memo is one more count per re-point, bounded by CASCADE_LIMIT.
  const queued = new Set<string>();
  const key = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
  queued.add(key(lo, hi));

  for (let step = 0; pending.length > 0; step += 1) {
    if (step >= CASCADE_LIMIT) {
      deps.log?.warn(
        { lo, hi, pending: pending.length },
        "storyline merge cascade hit its limit; the bridge sweep will finish it",
      );
      return;
    }
    const [a, b] = pending.shift()!;

    // The winner is the storyline with more groups, then the older UUID: a
    // merge must be replayable, and "more coverage wins" keeps the surviving
    // UUID the one more readers are likely to be holding.
    const [winnerId, loserId] = await pickWinner(deps, a, b);
    const result = await mergeStorylines(deps.db, {
      winnerId,
      loserId,
      timeZone: deps.config.timeZone,
    });
    if (!result.merged) continue;

    outcome.merged.push({ winnerId, loserId });
    if (outcome.storylineId === loserId) outcome.storylineId = winnerId;

    // Everything whose evidence just moved onto the survivor, re-asked against
    // K — the loop this bug was missing.
    const survivor = result.winnerId ?? winnerId;
    for (const other of result.repointed) {
      if (other === survivor) continue;
      const pairKey = key(survivor, other);
      if (queued.has(pairKey)) continue;
      const bridges = await countBridges(deps.db, {
        storylineA: survivor,
        storylineB: other,
      });
      if (bridges < deps.config.mergeBridges) continue;
      queued.add(pairKey);
      pending.push([survivor, other]);
    }
  }
}

export interface BridgeSweepReport {
  /** Pairs found at or above K. */
  found: number;
  merged: number;
  failures: number;
  /** True when the run stopped on its bound with work still outstanding. */
  incomplete: boolean;
  /**
   * Surviving storylines, alias-resolved and deduped — what the caller must
   * re-label. A merge is one of ADR-0011's three label triggers because the
   * story changed shape, and a survivor that absorbed three arcs is described by
   * a label made for a third of it.
   */
  survivors: string[];
}

/**
 * The bridge sweep: merge every live pair already holding K independent bridges.
 *
 * The linker checks K on the insert, which is the only moment it sees. That is
 * enough for the pair being bridged and was never enough for the pairs a MERGE
 * re-points — `cascadeMerge` closes that on the live path, and this closes it
 * over the archive, where the misses have already accumulated: 31 pairs stood at
 * or above K in the dev archive with the bridge merge never having fired once.
 *
 * Runs to a fixed point rather than once, because merging a pair re-points more
 * evidence and can lift another pair to K — the same reason the cascade exists,
 * at archive scale. `maxPasses` bounds a pathological chain, and an incomplete
 * run says so instead of looping.
 *
 * Never throws for one pair's sake, the posture every storyline pass here takes.
 */
export async function runBridgeSweep(
  deps: LinkerDeps,
  options: { batchSize?: number; maxPasses?: number } = {},
): Promise<BridgeSweepReport> {
  const batchSize = options.batchSize ?? 500;
  const maxPasses = options.maxPasses ?? 20;
  const report: BridgeSweepReport = {
    found: 0,
    merged: 0,
    failures: 0,
    incomplete: false,
    survivors: [],
  };
  // Winners collected as ids and resolved at the end: a survivor of one pass can
  // be absorbed by a later one, and re-labelling an alias spends a model call to
  // write a label nothing reads.
  const winners = new Set<string>();

  for (let pass = 0; ; pass += 1) {
    if (pass >= maxPasses) {
      report.incomplete = true;
      break;
    }
    const pairs = await readBridgedPairs(deps.db, {
      minBridges: deps.config.mergeBridges,
      limit: batchSize,
    });
    if (pairs.length === 0) break;
    report.found += pairs.length;

    let mergedThisPass = 0;
    for (const pair of pairs) {
      // A pair may have been dissolved by an earlier merge in this same pass —
      // both sides absorbed into one storyline. `mergeStorylines` resolves and
      // returns `merged: false`, which is not a failure.
      const outcome: LinkOutcome = {
        groupId: "",
        storylineId: pair.lo,
        attached: false,
        attachedTo: [],
        promoted: [],
        bridged: [],
        merged: [],
      };
      try {
        await cascadeMerge(deps, pair.lo, pair.hi, outcome);
        mergedThisPass += outcome.merged.length;
        report.merged += outcome.merged.length;
        for (const merge of outcome.merged) {
          winners.add(merge.winnerId);
          winners.delete(merge.loserId);
        }
      } catch (error) {
        report.failures += 1;
        deps.log?.warn(
          { err: error, lo: pair.lo, hi: pair.hi },
          "bridge sweep: one pair failed to merge; it stands where it stood",
        );
      }
    }

    // Nothing moved, but pairs are still above K: every one of them refused to
    // merge (all failures, or all already dissolved). Another pass would read
    // the same rows and do the same nothing.
    if (mergedThisPass === 0) {
      report.incomplete = report.failures > 0;
      break;
    }
  }

  // Resolve once at the end rather than per merge: a winner absorbed by a later
  // pass must not be handed back as something to re-label.
  const survivors = new Set<string>();
  for (const winner of winners) {
    const resolved = await resolveStoryline(deps.db, winner);
    if (resolved !== null) survivors.add(resolved);
  }
  report.survivors = [...survivors];

  // The summary belongs to the caller: `LinkerDeps` carries only `warn`, which
  // is the right level for a per-pair failure and the wrong one for a tally.
  return report;
}

async function pickWinner(
  deps: LinkerDeps,
  a: string,
  b: string,
): Promise<[winner: string, loser: string]> {
  const rows = await deps.db
    .selectFrom("storyline_groups")
    .select(["storyline_id", (eb) => eb.fn.countAll<string>().as("n")])
    .where("storyline_id", "in", [a, b])
    .groupBy("storyline_id")
    .execute();
  const count = (id: string): number =>
    Number(rows.find((row) => row.storyline_id === id)?.n ?? 0);
  const na = count(a);
  const nb = count(b);
  if (na !== nb) return na > nb ? [a, b] : [b, a];
  return a < b ? [a, b] : [b, a];
}
