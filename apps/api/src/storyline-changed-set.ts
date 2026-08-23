import type { Kysely } from "kysely";
import {
  readInverseCandidateGroups,
  readLinkDirtyStorylines,
  type Database,
  type LinkDirtyStoryline,
} from "@zammy/storage";
import type { LinkerConfig } from "./storyline-linker.js";

/**
 * Which groups the nightly late-candidate sweep still has a reason to offer
 * (docs/RESEARCH-BIRTH-TRIGGERED-LATE-CANDIDATES.md §9).
 *
 * The unfiltered sweep offers every group in the trailing DF window every
 * night — 12,338 groups, and most of them are being asked a question whose
 * inputs are byte for byte what they were last night. This narrows it to the
 * groups whose ANSWER could have moved, by starting from the arcs that changed
 * (`storylines.link_dirty_at`, migration 0017) and asking each one which groups
 * it could now take.
 *
 * Two sources per changed arc, and both are needed:
 *
 *  1. **its own member groups.** An article joining a member group widens that
 *     group's majority profile, which is a fact about the GROUP that no
 *     storyline-shaped signal carries — `markGroupStorylinesLinkDirty` marks the
 *     group's arcs precisely so the group itself travels here.
 *  2. **the inverse retrieval** (`readInverseCandidateGroups`): old window groups
 *     that could now qualify for this arc, because its profile widened or its
 *     coverage moved.
 *
 * Nothing here decides anything. Every group it names goes to `linkGroup`, which
 * re-derives the profile, re-reads the corpus at the GROUP's own instant, and
 * applies the same thresholds it always did. This is a retrieval bound, and its
 * job is to be a superset of what would change something.
 *
 * ## What it can and cannot filter on
 *
 * Not on the mass floor and not on the anchor, which is where the design this
 * replaces went wrong — both are functions of the fortnight the reader is
 * standing in, and the inverse retrieval stands in the arc's while `linkGroup`
 * will stand in each group's. `readInverseCandidateGroups` has the measurement:
 * that form reached 38.9% of the pairs the real forward decision qualified.
 *
 * What is left is the overlap, the window, and the shared-token count the mass
 * floor implies at any window. That is a much weaker filter than §3 priced, and
 * the cost shows up as offers rather than as missed links — which is the right
 * direction, and the reason docs/ARCHITECTURE.md §9.1 states what the narrowed
 * pass is worth rather than quoting the research's figure.
 */

/** How many groups one changed arc may name. */
const INVERSE_LIMIT = 200;

export interface ChangedSetDeps {
  db: Kysely<Database>;
  config: LinkerConfig;
  log?: { warn: (obj: object, msg: string) => void };
}

export interface ChangedSetBatch {
  /** Group ids to offer, deduped. Publication order is the CALLER's job. */
  groupIds: string[];
  /** The markers as read, for the caller's compare-and-clear. */
  markers: { id: string; dirtyAt: Date }[];
  /** Where to resume, or null when the queue is drained. */
  next: { dirtyAt: Date; id: string } | null;
  /** Arcs whose inverse retrieval could not run: no corpus, or no profile. */
  skipped: number;
}

/**
 * One batch of changed arcs, turned into the groups they name.
 *
 * Never throws for one arc's sake, exactly as the sweep it feeds does not: an
 * arc whose retrieval fails keeps its marker (the caller only clears markers for
 * arcs it saw) and is asked again next night.
 */
export async function readChangedSetBatch(
  deps: ChangedSetDeps,
  query: {
    /** The trailing DF window's start — the same bound the full sweep pages on. */
    publishedFrom: Date;
    after?: { dirtyAt: Date; id: string };
    /**
     * The queue as it stood when the pass began. Required in practice, not
     * cosmetic: this pass's own attaches and merges re-mark arcs AHEAD of the
     * cursor, so without it one pass chases the cascade instead of asking one
     * night's questions. `readLinkDirtyStorylines` has the measurement.
     */
    markedBefore?: Date;
    /** Arcs per read. Bounds memory and round trips, not correctness. */
    limit: number;
  },
): Promise<ChangedSetBatch> {
  const arcs = await readLinkDirtyStorylines(deps.db, {
    limit: query.limit,
    ...(query.after ? { after: query.after } : {}),
    ...(query.markedBefore ? { markedBefore: query.markedBefore } : {}),
  });

  const groupIds = new Set<string>();
  const markers: { id: string; dirtyAt: Date }[] = [];
  let skipped = 0;
  const minSharedTokens = arcs.length > 0 ? await sharedTokenFloor(deps) : 2;

  for (const arc of arcs) {
    markers.push({ id: arc.id, dirtyAt: arc.dirtyAt });
    // Member groups travel unconditionally. They are the group-membership class,
    // and it needs no arithmetic to know the group moved.
    for (const groupId of arc.memberGroupIds) groupIds.add(groupId);

    try {
      const found = await inverseFor(deps, arc, query.publishedFrom, minSharedTokens);
      if (found === null) skipped += 1;
      else for (const groupId of found) groupIds.add(groupId);
    } catch (error) {
      skipped += 1;
      deps.log?.warn(
        { err: error, storylineId: arc.id },
        "changed-set filter: one arc's inverse retrieval failed; its marker stands",
      );
    }
  }

  const last = arcs[arcs.length - 1];
  return {
    groupIds: [...groupIds],
    markers,
    next:
      arcs.length < query.limit || last === undefined
        ? null
        : { dirtyAt: last.dirtyAt, id: last.id },
    skipped,
  };
}

/**
 * The groups one changed arc could now take, or null when it has no profile to
 * ask with.
 *
 * The only arithmetic left here is the shared-token floor, and it is derived
 * rather than tuned: the largest weight one token can carry is `ln(N)`, so
 * `massFloor` needs at least `ceil(massFloor / ln(N))` shared tokens. `N` is
 * taken as the WIDEST corpus the window holds rather than the arc's own, because
 * a larger `N` yields a smaller — looser, and therefore safe — count. See
 * `readInverseCandidateGroups` for why nothing else about the mass or the anchor
 * can be evaluated here at all.
 */
async function inverseFor(
  deps: ChangedSetDeps,
  arc: LinkDirtyStoryline,
  publishedFrom: Date,
  minSharedTokens: number,
): Promise<string[] | null> {
  if (arc.profileTokens.length === 0) return null;

  return readInverseCandidateGroups(deps.db, {
    storylineId: arc.id,
    profileTokens: arc.profileTokens,
    publishedFrom,
    minSharedTokens,
    limit: INVERSE_LIMIT,
  });
}

/**
 * `ceil(massFloor / ln(N))`, at the widest `N` the window holds.
 *
 * Read once per batch, not once per arc: it is a property of the corpus rather
 * than of any storyline, and it barely moves — 3 at every size between roughly
 * 800 and 20,000 articles. Widest because the bound has to hold for the group
 * whose own window is widest, and a wider window makes the count SMALLER.
 *
 * `story_corpus_days` is itself pruned to `windowDays + 1` (`pruneStoryDf`), so
 * summing the whole table IS the widest window. Summing across languages too,
 * which no single group is measured against — that only inflates `N`, and
 * inflating `N` shrinks the count, which is the safe direction.
 *
 * At least 2: one token cannot carry a mass floor of 20 at any corpus size this
 * archive will see (`ln(N) >= 20` needs 485 million articles), and a floor of 1
 * would mean "shares anything", which is what `profile_tokens &&` already says.
 */
async function sharedTokenFloor(deps: ChangedSetDeps): Promise<number> {
  const row = await deps.db
    .selectFrom("story_corpus_days")
    .select((eb) => eb.fn.sum<string | null>("articles").as("n"))
    .executeTakeFirst();
  const widest = Math.max(2, Number(row?.n ?? 0));
  return Math.max(2, Math.ceil(deps.config.rules.massThreshold / Math.log(widest)));
}
