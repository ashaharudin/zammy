import type { Kysely } from "kysely";
import {
  attachGroup,
  countBridges,
  createProvisionalStoryline,
  mergeStorylines,
  promoteStoryline,
  readCandidateStorylines,
  readGroupStorylines,
  recordBridge,
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
  /** Storylines this group also qualified for — bridge evidence. */
  bridged: string[];
  /** Pairs this arrival's bridge pushed over K. */
  merged: { winnerId: string; loserId: string }[];
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

  const candidates = (
    await readCandidateStorylines(deps.db, { tokens: profile, limit: CANDIDATE_LIMIT })
  ).filter((candidate) => candidate.id !== own);

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
    // The BEST qualifier only, and only one per offer: a group that clears the
    // bar for four storylines is bridge evidence about those four (recorded
    // below), not a member of all of them — joining every qualifier is
    // percolation with extra steps.
    const already = new Set(existing);
    const arc = qualified.find((q) => !already.has(q.candidate.id));
    if (arc) {
      const { attached } = await attachGroup(deps.db, {
        storylineId: arc.candidate.id,
        groupId: group.groupId,
        ...zoned,
      });
      // Idempotent by construction — a nightly sweep re-offers the same
      // fortnight every night — so a replay reports nothing rather than
      // reporting the same attach again.
      if (attached) outcome.attachedTo.push(arc.candidate.id);
    }

    outcome.bridged = qualified.map((q) => q.candidate.id);
    await recordBridgesAmong(deps, qualified, group.groupId, outcome);
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
  const absorbed = await mergeStorylines(deps.db, {
    winnerId: best.candidate.id,
    loserId: own,
    ...zoned,
  });
  outcome.storylineId = absorbed.winnerId ?? best.candidate.id;
  outcome.attached = absorbed.merged;

  // Real now: a second group attached. Observed here rather than inferred by
  // storage, because a backfill attaches in an order where the promoting
  // arrival is not always the second row written.
  if (absorbed.merged) {
    await promoteStoryline(deps.db, { storylineId: outcome.storylineId });
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
    const { recorded } = await recordBridge(deps.db, {
      storylineA: a,
      storylineB: b,
      groupId,
    });
    if (!recorded) continue;

    if ((await countBridges(deps.db, { storylineA: a, storylineB: b })) < deps.config.mergeBridges) {
      continue;
    }
    // The winner is the storyline with more groups, then the older UUID: a
    // merge must be replayable, and "more coverage wins" keeps the surviving
    // UUID the one more readers are likely to be holding.
    const [winnerId, loserId] = await pickWinner(deps, a, b);
    const result = await mergeStorylines(deps.db, {
      winnerId,
      loserId,
      timeZone: deps.config.timeZone,
    });
    if (result.merged) {
      outcome.merged.push({ winnerId, loserId });
      if (outcome.storylineId === loserId) outcome.storylineId = winnerId;
    }
  }
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
