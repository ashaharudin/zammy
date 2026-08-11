import { sql, type Kysely, type Selectable } from "kysely";
import { Article, type Cursor } from "@zammy/shared";
import { hexToBytea, type ArticlesTable, type Database } from "./database.js";

/**
 * The timeline read (ARCHITECTURE 7.3): keyset pagination over article GROUPS.
 *
 * Deduplication is a property of the table, not a filter applied here — that is
 * the whole reason `articles` and `sightings` are separate. Keyset rather than
 * OFFSET because articles arrive continuously: rows cannot shift between pages
 * and cause duplicates or skips, and cost is constant regardless of depth.
 *
 * Grouping (§14.3) keeps that property rather than trading it away. A page is
 * N GROUPS, materialized at write time and read as an index scan over
 * `(group_published, group_id)` — never N articles collapsed afterwards, which
 * is the read-time approach ADR-0002 rejected for making page size
 * unpredictable and `hasMore` unreliable. An ungrouped article is a group of
 * one whose position and identity are its own, so a store with no grouping
 * pages exactly as it did before the column existed.
 */

export interface TimelineQuery {
  /** sha256 hex fingerprint of the topic (§6.2). */
  fingerprint: string;
  /**
   * Window over an ARTICLE's published, inclusive `from`, exclusive `to`. A
   * group qualifies when any of its members does, and then arrives whole.
   */
  from?: Date;
  to?: Date;
  /** Resume after this `(published, id)` tuple; omitted on the first page. */
  cursor?: Cursor;
  /** Page size, in groups. The API layer validates; this is a positive integer. */
  limit: number;
}

/**
 * One timeline slot: a story as this topic saw it covered.
 *
 * Which member holds the headline is NOT decided here. The representative is
 * per-topic and is an editorial call (§14.3, `source-authority.ts` in the API
 * layer); storage's job is to hand over the group's members and its position.
 */
export interface TimelineGroup {
  /** The group's identity — its seed article's id, and the cursor's id half. */
  id: string;
  /**
   * MIN(published) over the group: where the group sits, and the time the UI
   * shows. Independent of which member holds the headline, so a later
   * tier-1 article changes the headline in place without moving the group.
   */
  published: string;
  /** Members belonging to THIS topic, newest first. Never empty. */
  members: Article[];
}

export interface TimelinePage {
  /** `group_published` DESC, `group_id` DESC — a total order upstream does not provide. */
  items: TimelineGroup[];
  /** Present exactly when `hasMore`; feed it back as `cursor`. */
  nextCursor: Cursor | null;
  /**
   * More rows exist past this page IN OUR STORE. Says nothing about whether
   * upstream has more — that is `meta.ingest.state`, and conflating the two
   * tells users "that's everything" while a job is still running (§6.1).
   */
  hasMore: boolean;
}

export async function readTimelinePage(
  db: Kysely<Database>,
  query: TimelineQuery,
): Promise<TimelinePage> {
  const fingerprint = hexToBytea(query.fingerprint);

  // Step 1 — the page of groups, over the keyset axis. Both selected columns
  // are functions of the group, so DISTINCT costs nothing beyond folding a
  // group's several members into the one row that represents it here.
  let positions = db
    .selectFrom("topic_articles as ta")
    .innerJoin("articles as a", "a.id", "ta.article_id")
    .select(["a.group_id as id", "a.group_published as published"])
    .distinct()
    .where("ta.fingerprint", "=", fingerprint)
    .orderBy("a.group_published", "desc")
    .orderBy("a.group_id", "desc")
    // One row past the page: the cheap, exact hasMore probe.
    .limit(query.limit + 1);

  // The window selects groups by their MEMBERS' own `published`, not by the
  // group's position. Filtering on the position would drop an article that
  // falls squarely inside the requested window because its group happens to
  // sit just before it — and coverage would then record that window as
  // fetched, so nothing would ever go looking for it again (§7.2). A group
  // whose position predates `from` therefore appears, and sits at its true
  // position: the slot is honest about when the story was first reported.
  if (query.from) positions = positions.where("a.published", ">=", query.from);
  if (query.to) positions = positions.where("a.published", "<", query.to);
  if (query.cursor) {
    // Row-value comparison, matching the (published DESC, id DESC) order — a
    // pair of scalar comparisons gets the mid-tie case wrong.
    positions = positions.where(
      sql<boolean>`(a.group_published, a.group_id) < (${new Date(query.cursor.published)}::timestamptz, ${query.cursor.articleId}::bigint)`,
    );
  }

  const fetched = await positions.execute();
  const hasMore = fetched.length > query.limit;
  const page = fetched.slice(0, query.limit);
  if (page.length === 0) return { items: [], hasMore: false, nextCursor: null };

  // Step 2 — the members, for this topic only. A group is global, but a global
  // headline could surface an article that never matched what the user
  // searched and hide the matching one under "related" (§14.3).
  const members = await db
    .selectFrom("topic_articles as ta")
    .innerJoin("articles as a", "a.id", "ta.article_id")
    .selectAll("a")
    .where("ta.fingerprint", "=", fingerprint)
    .where(
      "a.group_id",
      "in",
      page.map((group) => group.id),
    )
    .orderBy("a.published", "desc")
    .orderBy("a.id", "desc")
    .execute();

  const byGroup = new Map<string, Article[]>();
  for (const row of members) {
    const list = byGroup.get(row.group_id);
    if (list) list.push(toArticle(row));
    else byGroup.set(row.group_id, [toArticle(row)]);
  }

  const items = page.map((group) => ({
    id: group.id,
    published: group.published.toISOString(),
    // Non-empty by construction: every id here came from a member row.
    members: byGroup.get(group.id) ?? [],
  }));

  const last = page.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? { published: last.published.toISOString(), articleId: last.id }
        : null,
  };
}

type ArticleRow = Selectable<ArticlesTable>;

/**
 * Row → shared contract, validated on the way out. Parsing here mirrors the
 * client's last-gate normalization (§5.2): if a row cannot satisfy the contract
 * the browser depends on, that is a fact to surface at the seam, not in React.
 */
function toArticle(row: ArticleRow): Article {
  return Article.parse({
    id: row.id,
    url: row.url,
    title: row.title,
    description: row.description,
    author: row.author,
    imageUrl: row.image_url,
    language: row.language,
    categories: row.categories,
    sourceCategories: row.source_category,
    sourceDomain: row.source_domain,
    published: row.published.toISOString(),
    sightingCount: row.sighting_count,
    latestSeen: row.latest_seen.toISOString(),
  });
}
