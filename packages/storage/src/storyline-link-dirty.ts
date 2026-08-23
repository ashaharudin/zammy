import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

/**
 * The "changed since" marker the nightly late-candidate sweep filters on, and
 * the inverse of candidate retrieval that turns one changed arc into the groups
 * worth re-offering to it (migration 0017;
 * docs/RESEARCH-BIRTH-TRIGGERED-LATE-CANDIDATES.md §3 and §9).
 *
 * Its own module rather than more of `storylines.ts` because it is a different
 * kind of thing: `storylines.ts` is the storyline's own reads and writes, and
 * this is bookkeeping ABOUT them for one caller. The marker's write paths still
 * live where the change happens — an arc that gains a group marks itself inside
 * `attachGroup` — and only the queue's own reads and clears are here.
 */

/**
 * Mark storylines as having changed under the linker.
 *
 * Called from the write paths that move something `linkGroup` READS about an arc
 * — its profile, its membership, its last coverage — and from the grouping layer
 * when an article joins one of its member groups.
 *
 * The DATABASE's `now()` rather than a caller's clock, and consistently so —
 * every writer here and in the grouping layer uses it. The marker is only ever
 * compared against itself (the sweep clears no marker newer than the one it read,
 * and reads no marker newer than `readLinkDirtyClock` at pass start), never
 * against a schedule, so what it needs is ONE monotone clock rather than a
 * business timestamp. The column is `timestamptz(3)` so the round trip through a
 * millisecond-precision `Date` is still exact — migration 0017 says what breaks
 * otherwise.
 *
 * Aliases are skipped. A merged-away UUID is not a candidate — the partial GIN
 * index does not contain it and its profile is emptied on merge — so marking one
 * would hand the sweep an arc with nothing to offer.
 */
export async function markStorylinesLinkDirty(
  db: Kysely<Database>,
  storylineIds: readonly string[],
): Promise<void> {
  if (storylineIds.length === 0) return;
  await sql`
    update storylines
    set link_dirty_at = now()
    where merged_into is null
      and id = any(${[...storylineIds]}::uuid[])
  `.execute(db);
}

/**
 * The DATABASE's clock, for bounding the sweep's queue.
 *
 * Every marker is stamped by `now()` on the server, so the bound that says "the
 * queue as it stood when the pass began" has to come from the same clock. A
 * caller's `Date` would be a second clock with its own skew — and in a test with
 * an injected clock it is not even the same year, which is how this was found.
 */
export async function readLinkDirtyClock(db: Kysely<Database>): Promise<Date> {
  const { rows } = await sql<{ at: Date }>`select now() as at`.execute(db);
  return rows[0]!.at;
}

/**
 * Mark every storyline holding this GROUP as changed.
 *
 * The grouping layer's entry point, and the case the storyline layer cannot see
 * for itself: an article joining a group changes that group's member ARTICLES,
 * so both of a storyline's derivations go stale and — more to the point — the
 * group's own MAJORITY profile widens, which is a fact about the group that no
 * storyline-shaped signal carries. Marking the group's storylines is how the
 * group reaches the sweep at all, because a changed arc's member groups are
 * offered alongside whatever its inverse retrieval finds.
 *
 * This one runs on the INGEST path, inside `recordGrouping`'s transaction and so
 * inside the §6.3 sync-fill deadline, and it runs whether or not the filter that
 * reads it is switched on. MEASURED at **0.68ms** mean over 300 real groups (p90
 * 0.79) — one index lookup on `storyline_groups_group_idx` and an update of one
 * or two rows. At roughly 1.4 joined articles per upstream page that is ~1ms of a
 * 1,200ms budget, which is why it is unconditional rather than behind the knob:
 * a marker only written when the filter is already on could never be turned on,
 * because the first filtered night would find an empty queue.
 */
export async function markGroupStorylinesLinkDirty(
  db: Kysely<Database>,
  groupId: string,
): Promise<void> {
  await sql`
    update storylines
    set link_dirty_at = now()
    where merged_into is null
      and id in (select storyline_id from storyline_groups where group_id = ${groupId}::bigint)
  `.execute(db);
}

/** One changed arc, as the sweep's filter needs to see it. */
export interface LinkDirtyStoryline {
  id: string;
  /** The marker as read, so the clear can refuse to swallow a newer write. */
  dirtyAt: Date;
  profileTokens: string[];
  /** Its member groups — offered alongside whatever the inverse retrieval finds. */
  memberGroupIds: string[];
}

/**
 * The changed arcs, oldest marker first, keyset-paged.
 *
 * Keyset on `(link_dirty_at, id)` rather than OFFSET for the reason §7.3 gives
 * and one more: this pass WRITES as it reads — an offer can attach, merge, and
 * re-mark — so an offset over a set being mutated skips rows.
 *
 * Oldest first because a marker is a debt: an arc that changed two nights ago
 * and was missed should be offered before one that changed an hour ago.
 *
 * `markedBefore` is what stops the pass chasing its own tail, and it is not
 * optional in practice. The keyset walks FORWARD through a queue the pass is
 * APPENDING to: every attach and merge an offer performs stamps its arc with
 * `now()`, which lands ahead of the cursor and is picked up later in the same
 * pass. That terminates — each productive round consumes a group's one lifetime
 * retroactive slot or a live storyline, both monotone — but it turns one night's
 * pass into "keep going until the graph stops moving", which is not what a
 * nightly pass is. MEASURED: without this bound a filtered pass over the dev
 * archive was still finding ~2,400 dirty arcs after twenty minutes, its own
 * re-marks outpacing the drain. Bounding to the queue as it stood at the start
 * also restores the ordering discipline the unfiltered pass has for free — one
 * pass, one fixed set of questions — and leaves the cascade to the next run.
 */
export async function readLinkDirtyStorylines(
  db: Kysely<Database>,
  query: { after?: { dirtyAt: Date; id: string }; markedBefore?: Date; limit: number },
): Promise<LinkDirtyStoryline[]> {
  const { rows } = await sql<{
    id: string;
    link_dirty_at: Date;
    profile_tokens: string[];
    member_group_ids: string[];
  }>`
    select s.id,
           s.link_dirty_at,
           s.profile_tokens,
           (select coalesce(array_agg(g.group_id::text order by g.group_id), '{}')
              from storyline_groups g where g.storyline_id = s.id) as member_group_ids
    from storylines s
    where s.link_dirty_at is not null
      and s.merged_into is null
      and ${
        query.markedBefore
          ? sql`s.link_dirty_at <= ${query.markedBefore}`
          : sql`true`
      }
      and ${
        query.after
          ? sql`(s.link_dirty_at, s.id) > (${query.after.dirtyAt}, ${query.after.id}::uuid)`
          : sql`true`
      }
    order by s.link_dirty_at asc, s.id asc
    limit ${query.limit}
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    dirtyAt: row.link_dirty_at,
    profileTokens: row.profile_tokens,
    memberGroupIds: row.member_group_ids,
  }));
}

/**
 * Clear the markers the sweep just carried forward.
 *
 * Compare-and-clear, and that IS the design: `link_dirty_at <= $read` means a
 * write that landed while the pass was offering — an attach, a merge, one of the
 * pass's own cascades — has moved the marker forward and survives this, so it is
 * offered again next night rather than being silently consumed. A boolean flag
 * could not express that, which is the reason the marker is a timestamp.
 */
export async function clearStorylineLinkDirty(
  db: Kysely<Database>,
  markers: readonly { id: string; dirtyAt: Date }[],
): Promise<number> {
  if (markers.length === 0) return 0;
  const result = await sql<{ id: string }>`
    update storylines s
    set link_dirty_at = null
    from (
      select * from unnest(
        ${markers.map((m) => m.id)}::uuid[],
        ${markers.map((m) => m.dirtyAt)}::timestamptz[]
      ) as m(id, read_at)
    ) m
    where s.id = m.id
      and s.link_dirty_at is not null
      and s.link_dirty_at <= m.read_at
    returning s.id
  `.execute(db);
  return result.rows.length;
}

/**
 * The INVERSE of candidate retrieval: which groups in the window could now
 * qualify for THIS storyline (docs/RESEARCH-BIRTH-TRIGGERED-LATE-CANDIDATES.md
 * §3).
 *
 * Forward, the linker asks "which arcs overlap this group's profile". This asks
 * the same question from the other side, so a changed arc can name the groups
 * worth re-offering to it instead of the sweep offering the whole fortnight.
 *
 * ## Why this is a token-count filter and not the mass-and-anchor one
 *
 * The obvious design — and the one
 * docs/RESEARCH-BIRTH-TRIGGERED-LATE-CANDIDATES.md §3 specifies, with a plan and
 * a timing — pushes `qualifyingStorylines`' own predicates into SQL: at least
 * one shared token with `df <= anchorCeiling(N)`, and `Σ ln(N/df) >= massFloor`.
 * **It does not work, and the reason is not a bug in the SQL.**
 *
 * Those predicates are functions of `N` and `df`, and `N` and `df` are functions
 * of WHICH FORTNIGHT the reader is standing in. The inverse retrieval stands in
 * the arc's; `linkGroup` will stand in each candidate group's. `pruneStoryDf`
 * deletes buckets past `windowDays + 1`, so an old group's window is mostly gone
 * and its corpus is a fraction of a recent arc's — and `anchorDfFloor` does not
 * scale with it. MEASURED, one real missed pair: the group's window held 1,074
 * articles, so its ceiling floored out at 10 and its shared tokens had df 6, mass
 * 31.8, comfortably qualifying. The arc's window held 13,489, ceiling 27, and the
 * SAME tokens had df 32–171 — not one of them anchor-eligible, so the arc's
 * inverse retrieval named nothing at all. Over 400 sampled window groups the
 * mass-and-anchor form reached **38.9%** of the pairs the real forward decision
 * qualified. A filter that misses three in five is worse than a slow sweep,
 * because the tally still reads clean.
 *
 * And it cannot be repaired by loosening, because there is no
 * window-independent anchor filter to loosen TO: pruning can shrink a group's
 * `df` arbitrarily, so for any token there is some group whose window makes it
 * rare.
 *
 * What DOES survive is §3's own corollary, which is the one part of the mass
 * floor that does not depend on the window. The largest weight any single token
 * can carry is `ln(N)`, so clearing `massFloor` needs at least
 * `ceil(massFloor / ln(N))` shared tokens — 3 at every corpus size this archive
 * has held, and monotonically MORE as `N` shrinks. So the caller derives the
 * count from the largest `N` it knows about, which makes the bound the loosest
 * one and therefore the safe one.
 *
 * So the predicates here are:
 *
 *  - **the overlap.** At least one shared token, by GIN index — the same bound
 *    `profile_tokens &&` already is on the forward side.
 *  - **`minSharedTokens`.** Necessary for the mass floor, at any window.
 *  - **the window.** `group_published >= publishedFrom`: the same trailing DF
 *    bound the unfiltered sweep pages on, denormalized onto every member and
 *    already indexed.
 *  - **not already a member.** Exactly as the forward path excludes `own`: a
 *    member's fit for the arc it belongs to is the trivial one.
 *
 * A group has no stored profile — it is the MAJORITY of its members' tokens,
 * computed per read — so the count here is over the UNION of its members'
 * tokens. The union is a superset of the majority, so the count is an upper
 * bound on the majority's, and an upper bound OVER-offers rather than
 * under-offers. That is the direction that keeps a filter honest; `linkGroup`
 * then makes the real decision on the real profile at the group's own instant.
 *
 * `limit` is a safety valve for a pathological arc, not a tuning knob — the same
 * argument `readCandidateStorylines` makes about its own. Ordered by publication
 * so the cut, when it binds, keeps the OLDEST groups: those are the ones the
 * fresh path can never revisit, which is what a late-candidate offer is for.
 */
export async function readInverseCandidateGroups(
  db: Kysely<Database>,
  input: {
    storylineId: string;
    /** The arc's profile tokens — what a candidate group must overlap. */
    profileTokens: readonly string[];
    /** The trailing DF window's start. */
    publishedFrom: Date;
    /**
     * How many tokens a group must share before the mass floor is even
     * reachable. See this function's doc comment: it is a floor derived from the
     * floor, and it is the only part of the decision that survives not knowing
     * which fortnight the group will be judged against.
     */
    minSharedTokens: number;
    limit: number;
  },
): Promise<string[]> {
  if (input.profileTokens.length === 0) return [];

  const { rows } = await sql<{ group_id: string }>`
    with candidate as (
      -- The GIN probe selects GROUPS, and the shared-token count is then taken
      -- over ALL of their articles. Two stages rather than one, and the
      -- difference is not cosmetic: filtering ARTICLES by the overlap drops
      -- every member that does not itself carry a shared token, so a group whose
      -- vocabulary is spread across two outlets' wordings undercounts and fails a
      -- floor it clears.
      select distinct a.group_id
      from articles a
      where a.story_tokens && ${[...input.profileTokens]}::text[]
        and a.group_published >= ${input.publishedFrom}
    ),
    shared as (
      select a.group_id,
             count(distinct u.tok) as toks,
             min(a.group_published) as published
      from candidate
        join articles a on a.group_id = candidate.group_id
        join lateral unnest(a.story_tokens) as u(tok) on true
      where u.tok = any(${[...input.profileTokens]}::text[])
      group by a.group_id
    )
    select group_id
    from shared
    where toks >= ${input.minSharedTokens}
      and group_id not in (
        select group_id from storyline_groups where storyline_id = ${input.storylineId}::uuid
      )
    order by published asc, group_id asc
    limit ${input.limit}
  `.execute(db);

  return rows.map((row) => row.group_id);
}
