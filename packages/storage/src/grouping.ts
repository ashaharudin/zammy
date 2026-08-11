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
 * Record one grouping decision: store the article's headline tokens and, when
 * a group was chosen, move it there.
 *
 * `groupId: null` means "stays a group of one" — still a write, because the
 * tokens are what make this article a candidate for the next arrival.
 *
 * Only a SINGLETON may move. Re-pointing an article that already has members
 * would strand them in a group whose seed lives elsewhere, and the guard also
 * makes the call idempotent: a replayed batch (retries make that routine,
 * §7.4) re-runs it as a no-op.
 */
export async function recordGrouping(
  db: Kysely<Database>,
  input: {
    articleId: string;
    titleTokens: readonly string[];
    /** Which tokenizer produced them, so staleness stays findable (ADR-0005). */
    tokensVersion: number;
    groupId: string | null;
  },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("articles")
      .set({ title_tokens: [...input.titleTokens], tokens_version: input.tokensVersion })
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
    }
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
 * its group's position — never raise it. That makes the maintenance a `least`
 * against one timestamp instead of a MIN over the group, and the `where` turns
 * the overwhelmingly common case (a sighting no earlier than the group's
 * position) into a no-op.
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
    language: row.language,
    published: row.published,
    groupId: row.group_id,
    isGroupOfOne: row.is_group_of_one,
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
