import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";
import { markGroupStorylinesLinkDirty } from "./storyline-link-dirty.js";
import { absorbMergedGroup } from "./storylines.js";

/**
 * Article grouping, storage side (ARCHITECTURE 14.3).
 *
 * The division of labour: everything judgemental — which headlines are the
 * same story — belongs to the API layer, and everything *bounding* belongs
 * here, because the bounds are what keep the feature safe:
 *
 *  - candidates come from ONE `APP_TIMEZONE` calendar day, passed in as
 *    `[from, to)` (§10.1's rule, computed by the caller as everywhere else),
 *    and that window is what bounds how far a group can drift;
 *  - a group's position is MIN(published) over its members, maintained on
 *    every write so §7.3's keyset stays an index scan.
 *
 * Candidates are ANY member of a same-day group, not the seed alone. Seed-only
 * comparison was the original rule and it measurably lost real syndication: a
 * wire story reaches a group through whichever member it most resembles, and
 * that is rarely the arbitrary article that happened to arrive first (§14.3,
 * ADR-0005).
 */

/** An article a newcomer may be compared against, and the group it belongs to. */
export interface GroupCandidate {
  id: string;
  /** The group this candidate is in. Equals `id` only for a group of one. */
  groupId: string;
  titleTokens: string[];
  /** Needed for the figure rule, which reads numerals the tokenizer drops. */
  title: string;
  published: Date;
}

export interface GroupCandidateQuery {
  /** The article's `APP_TIMEZONE` day, as UTC instants (§10.1). */
  from: Date;
  to: Date;
  /** Matched with IS NOT DISTINCT FROM, so unknown language groups with unknown. */
  language: string | null;
  titleTokens: readonly string[];
  /** The article being grouped, which is a group of one until it moves. */
  excludeArticleId: string;
  /**
   * Safety valve for a pathological day, not a tuning knob. A day where one
   * token appears in thousands of headlines would otherwise make grouping one
   * article an unbounded scan; taking the most recent N is a worse grouping,
   * never a wrong row, because grouping fails soft (§14.3). It binds harder
   * now that members are candidates too — a large group spends several slots.
   */
  limit: number;
}

/**
 * Same-day articles in the same language sharing at least one headline token.
 *
 * The token overlap is a NARROWING device, not the decision — the GIN index
 * turns "compare against the day" into "compare against a handful", and the
 * similarity rule then throws most of those away.
 */
export async function readGroupCandidates(
  db: Kysely<Database>,
  query: GroupCandidateQuery,
): Promise<GroupCandidate[]> {
  if (query.titleTokens.length === 0) return [];

  const rows = await db
    .selectFrom("articles as a")
    .select(["a.id", "a.group_id", "a.title_tokens", "a.title", "a.published"])
    .where("a.published", ">=", query.from)
    .where("a.published", "<", query.to)
    .where(sql<boolean>`a.language is not distinct from ${query.language}`)
    .where(sql<boolean>`a.title_tokens && ${[...query.titleTokens]}::text[]`)
    .where("a.id", "!=", query.excludeArticleId)
    .orderBy("a.published", "desc")
    .orderBy("a.id", "desc")
    .limit(query.limit)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    titleTokens: row.title_tokens,
    title: row.title,
    published: row.published,
  }));
}

/**
 * Record one grouping decision: store the article's derived tokens and, when
 * a group was chosen, move it there.
 *
 * `groupId: null` means "stays a group of one" — still a write, because the
 * tokens are what make this article a candidate for the next arrival.
 * `storyTokens` travels with `titleTokens` when provided — both are
 * derivations of one tokenizer generation — and is left untouched when
 * omitted, so older callers keep meaning what they meant. They outlive the
 * day-bounded storyline that introduced them: they are the v2 linker's input
 * (ADR-0011).
 *
 * Only a SINGLETON may move. Re-pointing an article that already has members
 * would strand them in a group whose seed lives elsewhere, and the guard also
 * makes the call idempotent: a replayed batch (retries make that routine,
 * §7.4) re-runs it as a no-op.
 *
 * A group's storyline MEMBERSHIP is untouched here, and that part has not
 * changed: membership lives in `storyline_groups`, the group is the unit a
 * storyline holds, so an article moving between groups leaves every
 * `storyline_groups` row exactly where it was (ADR-0011).
 *
 * What this used to say — that the move is therefore invisible one layer up —
 * was the half of it that was wrong, and the sentence cost months. Two things
 * DO move, neither of them membership:
 *
 *   - **The derivations.** A storyline's day slots and its profile are computed
 *     over its member groups' ARTICLES, so an arrival makes both stale.
 *     `groupArticle` re-derives them on the spot rather than deferring; a wrong
 *     day slot is a wrong lead article on a card a reader is looking at now. If
 *     you are adding a caller that moves an article, that refresh is a real
 *     debt and not a formality.
 *   - **The change marker** (`markGroupStorylinesLinkDirty`, migration 0017).
 *     The arriving group's own majority profile can widen, handing it a
 *     vocabulary the linker has never judged — so the marker is how the nightly
 *     sweep's changed-set filter learns the group is worth re-offering.
 */
export async function recordGrouping(
  db: Kysely<Database>,
  input: {
    articleId: string;
    titleTokens: readonly string[];
    storyTokens?: readonly string[];
    /** Which tokenizer produced them, so staleness stays findable (ADR-0005). */
    tokensVersion: number;
    groupId: string | null;
  },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("articles")
      .set({
        title_tokens: [...input.titleTokens],
        tokens_version: input.tokensVersion,
        ...(input.storyTokens ? { story_tokens: [...input.storyTokens] } : {}),
      })
      .where("id", "=", input.articleId)
      .execute();

    if (input.groupId === null || input.groupId === input.articleId) {
      return;
    }

    const moved = await trx
      .updateTable("articles")
      .set({ group_id: input.groupId })
      .where("id", "=", input.articleId)
      .where(sql<boolean>`id = group_id`)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("articles as member")
              .select("member.id")
              .whereRef("member.group_id", "=", "articles.id")
              .where(sql<boolean>`member.id <> member.group_id`),
          ),
        ),
      )
      .executeTakeFirst();

    if (Number(moved.numUpdatedRows) > 0) {
      await refreshGroupPosition(trx, input.groupId);
      // The group the article joined now says something it did not say before,
      // and that is the class no storyline-shaped signal can carry (migration
      // 0017). Marked on the group it JOINED, not on the group it left: the
      // article was a group of one, so what it left has nothing left in it.
      await markGroupStorylinesLinkDirty(trx, input.groupId);
    }
  });
}

/**
 * Merge one group into another: the ADR-0009 repair for a split ADR-0005
 * declared unfixable by construction.
 *
 * Grouping evaluates an article once, at arrival, and only singletons may
 * move — so when one story's coverage forms two poles ("to leave" / "to step
 * down"), the split locks in the moment both poles have two members. The
 * repair acts on BRIDGE EVIDENCE: an arrival whose matches span both groups
 * above the grouping bar proves they are one story, and this call is how the
 * caller acts on it. Whole groups move — never a subset, so no member is ever
 * stranded.
 *
 * The loser's STORYLINE membership follows, and has to. A storyline holds
 * GROUPS, so a group that ceases to exist would leave every storyline holding
 * it pointing at an id with no articles behind it — and since both of a
 * storyline's derivations are computed over its member groups' articles, its
 * day slots would silently lose that coverage. Caught exactly that way: an
 * adopted article stopped counting toward its slot's position.
 *
 * This is not a storyline DECISION and so does not belong to the linker: no
 * judgement is made about what belongs with what. The winner simply IS the
 * loser now, everywhere the loser was named.
 *
 * Idempotent: a replayed merge finds the loser empty and does nothing.
 */
export async function mergeGroups(
  db: Kysely<Database>,
  input: {
    winnerGroupId: string;
    loserGroupId: string;
    /** The calendar day slots are bucketed by, since they are re-derived here. */
    timeZone: string;
  },
): Promise<{ merged: boolean }> {
  if (input.winnerGroupId === input.loserGroupId) return { merged: false };

  return db.transaction().execute(async (trx) => {
    const moved = await trx
      .updateTable("articles")
      .set({ group_id: input.winnerGroupId })
      .where("group_id", "=", input.loserGroupId)
      .executeTakeFirst();
    if (Number(moved.numUpdatedRows ?? 0) === 0) return { merged: false };

    await refreshGroupPosition(trx, input.winnerGroupId);

    // Every storyline that held the loser holds the winner instead.
    await absorbMergedGroup(trx, input);

    // The winner group's OWN storylines, which `absorbMergedGroup` does not
    // reach: it re-derives the arcs that held the LOSER, and the winner's arcs
    // kept their membership while the articles under it changed (migration
    // 0017).
    await markGroupStorylinesLinkDirty(trx, input.winnerGroupId);

    return { merged: true };
  });
}

/**
 * Re-derive a group's position from its members.
 *
 * Held on every member rather than looked up from the seed: the timeline pages
 * over `(group_published, group_id)`, and a self-join to find the seed's
 * timestamp would cost §7.3 its index scan on the hot read path.
 */
async function refreshGroupPosition(
  db: Kysely<Database>,
  groupId: string,
): Promise<void> {
  await sql`
    update articles a
    set group_published = g.min_published
    from (
      select min(published) as min_published from articles where group_id = ${groupId}
    ) g
    where a.group_id = ${groupId}
      and a.group_published is distinct from g.min_published
  `.execute(db);
}

/**
 * The ingest path's cheaper half: an article's `published` only ever moves
 * EARLIER (`LEAST`, ADR-0002), so folding a new sighting can only ever lower
 * its group's position, never raise it. That makes the maintenance a `least`
 * against one timestamp instead of a MIN over the group, and the `where` turns
 * the overwhelmingly common case (a sighting no earlier than the position)
 * into a no-op.
 *
 * The storyline layer one level up moves too, and NOT from here: this call
 * maintains `articles.group_published` and nothing else. Its only caller,
 * `ingestSightings`, re-derives the day slots of every storyline holding a
 * moved article once per batch, in the same transaction. Keeping the two apart
 * is what makes the storyline half affordable — this runs on every new
 * sighting, that one only when a fold actually moved something.
 */
export async function lowerGroupPosition(
  db: Kysely<Database>,
  input: { articleId: string; published: Date },
): Promise<void> {
  await sql`
    update articles
    set group_published = ${input.published}
    where group_id = (select group_id from articles where id = ${input.articleId})
      and group_published > ${input.published}
  `.execute(db);
}

/** An article the maintenance pass may need to re-derive (ADR-0005). */
export interface StoredArticle {
  id: string;
  title: string;
  /** Story tokens derive from title AND description (ADR-0009). */
  description: string | null;
  language: string | null;
  published: Date;
  /** The group it is in now — what a re-run compares its verdict against. */
  groupId: string;
  /** True when nothing else shares this article's group. */
  isGroupOfOne: boolean;
}

/**
 * Articles whose tokens predate `version`, oldest first.
 *
 * Oldest first so a resumed backfill makes monotonic progress: each batch
 * raises the version of what it touched, so the next call skips it. A crashed
 * run costs the batch it was in and nothing else.
 */
export async function readStaleTokenArticles(
  db: Kysely<Database>,
  query: { version: number; from: Date; limit: number },
): Promise<StoredArticle[]> {
  const rows = await db
    .selectFrom("articles as a")
    .select([
      "a.id",
      "a.title",
      "a.description",
      "a.language",
      "a.published",
      "a.group_id",
      sql<boolean>`not exists (
        select 1 from articles other
        where other.group_id = a.group_id and other.id <> a.id
      )`.as("is_group_of_one"),
    ])
    .where("a.tokens_version", "<", query.version)
    .where("a.published", ">=", query.from)
    .orderBy("a.published", "asc")
    .orderBy("a.id", "asc")
    .limit(query.limit)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    language: row.language,
    published: row.published,
    groupId: row.group_id,
    isGroupOfOne: row.is_group_of_one,
  }));
}

/** One whole group, as the v2 linker consumes it (ADR-0011). */
export interface LinkableGroupRow {
  groupId: string;
  /** Every member's `story_tokens` — the group's profile is their majority. */
  memberTokens: string[][];
  language: string | null;
  /** MIN(published) over the group: when this coverage happened. */
  published: Date;
}

/**
 * Groups in publication order, keyset-paged — the backfill's input (S5).
 *
 * Chronological because the linker is order-dependent and replay order is the
 * canonical order (ADR-0011's Rollout). Keyset rather than OFFSET for the
 * reason §7.3 gives: the backfill writes as it reads, and an offset over a
 * table being written to skips rows.
 *
 * The keyset is `(group_published, group_id)`, which is denormalized onto every
 * member and already indexed — so paging the whole archive by group costs the
 * same index scan the timeline pays.
 */
export async function readLinkableGroups(
  db: Kysely<Database>,
  query: {
    /**
     * Where to continue from. `inclusive` returns the cursor row ITSELF, which
     * is what resuming an interrupted run wants — the last group it reached may
     * have been half-processed, and only re-running it finishes the job. Paging
     * within a run wants the opposite, or every batch redoes its predecessor's
     * last group.
     */
    after?: { published: Date; groupId: string; inclusive?: boolean };
    /**
     * Push a window's start INTO the aggregate. The keyset alone starts the
     * page at the window, but the subquery still aggregates the whole archive
     * to build rows the WHERE then discards — `group_published` is denormalized
     * identically onto every member, so filtering members by it never splits a
     * group, and the fortnight sweep becomes an index-range scan instead of a
     * nightly full-table GROUP BY.
     */
    publishedFrom?: Date;
    /**
     * Aggregate ONLY these groups, ignoring the keyset entirely.
     *
     * For the one case the cursor cannot serve: a group in the middle of the
     * archive with no storyline at all, which a resume run starting after the
     * last linked group walks straight past. Pushed into the aggregate's WHERE
     * so it stays an index scan rather than a full GROUP BY that a filter then
     * discards.
     */
    onlyGroupIds?: readonly string[];
    limit: number;
  },
): Promise<LinkableGroupRow[]> {
  const { rows } = await sql<{
    group_id: string;
    language: string | null;
    published: Date;
    member_tokens: string[][];
  }>`
    select g.group_id,
           g.language,
           g.published,
           g.member_tokens
    from (
      select a.group_id,
             min(a.group_published) as published,
             min(a.language) as language,
             -- json_agg, not array_agg: Postgres cannot build a 2-D array from
             -- rows whose arrays differ in length ("cannot accumulate arrays of
             -- different dimensionality"), and member articles differ in length
             -- constantly — a headline with a description carries more tokens
             -- than one without.
             json_agg(a.story_tokens) as member_tokens
      from articles a
      where ${
        query.onlyGroupIds && query.onlyGroupIds.length > 0
          ? sql`a.group_id = any(${query.onlyGroupIds}::bigint[])`
          : query.publishedFrom
            ? sql`a.group_published >= ${query.publishedFrom}`
            : sql`true`
      }
      group by a.group_id
    ) g
    where ${
      query.after
        ? query.after.inclusive
          ? sql`(g.published, g.group_id) >= (${query.after.published}, ${query.after.groupId}::bigint)`
          : sql`(g.published, g.group_id) >  (${query.after.published}, ${query.after.groupId}::bigint)`
        : sql`true`
    }
    order by g.published asc, g.group_id asc
    limit ${query.limit}
  `.execute(db);

  return rows.map((row) => ({
    groupId: row.group_id,
    memberTokens: row.member_tokens,
    language: row.language,
    published: row.published,
  }));
}

/** How many groups the archive holds — the backfill's denominator. */
export async function countGroups(db: Kysely<Database>): Promise<number> {
  const { rows } = await sql<{ n: string }>`
    select count(distinct group_id) as n from articles
  `.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/** How many articles are still behind the current tokenizer. */
export async function countStaleTokenArticles(
  db: Kysely<Database>,
  query: { version: number; from: Date },
): Promise<number> {
  const row = await db
    .selectFrom("articles")
    .select(({ fn }) => fn.countAll<string>().as("n"))
    .where("tokens_version", "<", query.version)
    .where("published", ">=", query.from)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}
