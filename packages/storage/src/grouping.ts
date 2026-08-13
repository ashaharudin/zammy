import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

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
 * derivations of one tokenizer generation (ADR-0009) — and is left untouched
 * when omitted, so older callers keep meaning what they meant.
 *
 * Only a SINGLETON may move. Re-pointing an article that already has members
 * would strand them in a group whose seed lives elsewhere, and the guard also
 * makes the call idempotent: a replayed batch (retries make that routine,
 * §7.4) re-runs it as a no-op. A moved article also takes the target group's
 * STORYLINE — a group's members share one storyline by invariant, and the
 * join is what proves the two belong to the same story's coverage.
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

    const before = await trx
      .selectFrom("articles")
      .select("storyline_id")
      .where("id", "=", input.articleId)
      .executeTakeFirst();

    const moved = await trx
      .updateTable("articles")
      .set({
        group_id: input.groupId,
        // The target group's storyline, from any of its members — the seed row
        // may be gone one day (group_id carries no FK), and falling back to
        // the article's own storyline degrades softly instead of violating
        // NOT NULL.
        storyline_id: sql`coalesce(
          (select member.storyline_id from articles member
            where member.group_id = ${input.groupId} limit 1),
          storyline_id
        )`,
      })
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
      const after = await trx
        .selectFrom("articles")
        .select("storyline_id")
        .where("id", "=", input.articleId)
        .executeTakeFirstOrThrow();
      await refreshStorylinePosition(trx, after.storyline_id);
      // The storyline it left keeps only the members it still has; its
      // position must not keep pointing at an article that moved away.
      if (before && before.storyline_id !== after.storyline_id) {
        await refreshStorylinePosition(trx, before.storyline_id);
      }
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
 * stranded — and the loser's storyline follows: if the loser led a storyline,
 * its spokes re-point to the winner's; if it was a spoke, only its own
 * members move.
 *
 * Idempotent: a replayed merge finds the loser empty and does nothing.
 */
export async function mergeGroups(
  db: Kysely<Database>,
  input: { winnerGroupId: string; loserGroupId: string },
): Promise<{ merged: boolean }> {
  if (input.winnerGroupId === input.loserGroupId) return { merged: false };

  return db.transaction().execute(async (trx) => {
    const winner = await trx
      .selectFrom("articles")
      .select("storyline_id")
      .where("group_id", "=", input.winnerGroupId)
      .limit(1)
      .executeTakeFirst();
    const loser = await trx
      .selectFrom("articles")
      .select("storyline_id")
      .where("group_id", "=", input.loserGroupId)
      .limit(1)
      .executeTakeFirst();
    if (!winner || !loser) return { merged: false };

    // The winner may be a SPOKE of the very hub it is absorbing — the bridge
    // article arrived through the spoke's wording. Keeping the winner's
    // storyline id would leave the storyline named after a group that no
    // longer exists, and the attach path offers hubs only (groups leading the
    // storyline they are in), so the story would become invisible to every
    // later arrival. The winner's group takes over as hub instead.
    const storylineId =
      winner.storyline_id === input.loserGroupId
        ? input.winnerGroupId
        : winner.storyline_id;

    await trx
      .updateTable("articles")
      .set({ group_id: input.winnerGroupId })
      .where("group_id", "=", input.loserGroupId)
      .execute();

    // Normalize storylines: the merged group's members take the winner's
    // storyline, and — when the loser LED its storyline — its spokes follow
    // too, because their hub is now part of the winner's story.
    await trx
      .updateTable("articles")
      .set({ storyline_id: storylineId })
      .where((eb) =>
        eb.or([
          eb("group_id", "=", input.winnerGroupId),
          eb("storyline_id", "=", input.loserGroupId),
        ]),
      )
      .execute();

    await refreshGroupPosition(trx, input.winnerGroupId);
    await refreshStorylinePosition(trx, storylineId);
    if (loser.storyline_id !== storylineId) {
      await refreshStorylinePosition(trx, loser.storyline_id);
    }
    return { merged: true };
  });
}

/**
 * Move one whole GROUP to a storyline (ADR-0009): the attach decision's write
 * half, and the rebuild pass's only mutation.
 *
 * The caller owns the one-hop discipline — a hub that still has spokes is only
 * ever moved by a rebuild that is reassigning every group of the day anyway.
 */
export async function setStoryline(
  db: Kysely<Database>,
  input: { groupId: string; storylineId: string },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("articles")
      .select("storyline_id")
      .where("group_id", "=", input.groupId)
      .limit(1)
      .executeTakeFirst();
    if (!current || current.storyline_id === input.storylineId) return;

    await trx
      .updateTable("articles")
      .set({ storyline_id: input.storylineId })
      .where("group_id", "=", input.groupId)
      .execute();

    await refreshStorylinePosition(trx, input.storylineId);
    await refreshStorylinePosition(trx, current.storyline_id);
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

/** The storyline twin of `refreshGroupPosition`, for the same keyset reason. */
async function refreshStorylinePosition(
  db: Kysely<Database>,
  storylineId: string,
): Promise<void> {
  await sql`
    update articles a
    set storyline_published = s.min_published
    from (
      select min(published) as min_published from articles where storyline_id = ${storylineId}
    ) s
    where a.storyline_id = ${storylineId}
      and s.min_published is not null
      and a.storyline_published is distinct from s.min_published
  `.execute(db);
}

/**
 * The ingest path's cheaper half: an article's `published` only ever moves
 * EARLIER (`LEAST`, ADR-0002), so folding a new sighting can only ever lower
 * its group's — and therefore its storyline's — position, never raise it.
 * That makes the maintenance a `least` against one timestamp instead of a MIN
 * over the group, and the `where` turns the overwhelmingly common case (a
 * sighting no earlier than the position) into a no-op.
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
  await sql`
    update articles
    set storyline_published = ${input.published}
    where storyline_id = (select storyline_id from articles where id = ${input.articleId})
      and storyline_published > ${input.published}
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

/** One row of a day-language corpus, as the storyline pass consumes it. */
export interface StorylineDayRow {
  id: string;
  groupId: string;
  storylineId: string;
  published: Date;
  storyTokens: string[];
}

/**
 * Every article of one `APP_TIMEZONE` day in one language — the corpus the
 * storyline decision is made against (ADR-0009). Whole-day on purpose: the
 * anchor rule is DAY-RELATIVE ("rare within this day"), so a narrower read
 * would compute a different rarity than the rule means. A day is bounded
 * (~1,500 rows at current volume), and the read is one index scan.
 */
export async function readStorylineDay(
  db: Kysely<Database>,
  query: { from: Date; to: Date; language: string | null },
): Promise<StorylineDayRow[]> {
  const rows = await db
    .selectFrom("articles as a")
    .select(["a.id", "a.group_id", "a.storyline_id", "a.published", "a.story_tokens"])
    .where("a.published", ">=", query.from)
    .where("a.published", "<", query.to)
    .where(sql<boolean>`a.language is not distinct from ${query.language}`)
    .orderBy("a.published", "asc")
    .orderBy("a.id", "asc")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    storylineId: row.storyline_id,
    published: row.published,
    storyTokens: row.story_tokens,
  }));
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
