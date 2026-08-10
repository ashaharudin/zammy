import { sql, type Kysely, type Selectable } from "kysely";
import { Article, type Cursor } from "@zammy/shared";
import { hexToBytea, type ArticlesTable, type Database } from "./database.js";

/**
 * The timeline read (ARCHITECTURE 7.3): keyset pagination over ARTICLES.
 *
 * Deduplication is a property of the table, not a filter applied here — that is
 * the whole reason `articles` and `sightings` are separate. Keyset rather than
 * OFFSET because articles arrive continuously: rows cannot shift between pages
 * and cause duplicates or skips, and cost is constant regardless of depth.
 */

export interface TimelineQuery {
  /** sha256 hex fingerprint of the topic (§6.2). */
  fingerprint: string;
  /** Window over `published`, inclusive `from`, exclusive `to`. */
  from?: Date;
  to?: Date;
  /** Resume after this `(published, id)` tuple; omitted on the first page. */
  cursor?: Cursor;
  /** Page size. The API layer validates; this is a positive integer. */
  limit: number;
}

export interface TimelinePage {
  /** `published` DESC, `id` DESC — a total order upstream does not provide. */
  items: Article[];
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
  let rows = db
    .selectFrom("topic_articles as ta")
    .innerJoin("articles as a", "a.id", "ta.article_id")
    .selectAll("a")
    .where("ta.fingerprint", "=", hexToBytea(query.fingerprint))
    .orderBy("a.published", "desc")
    .orderBy("a.id", "desc")
    // One row past the page: the cheap, exact hasMore probe.
    .limit(query.limit + 1);

  if (query.from) rows = rows.where("a.published", ">=", query.from);
  if (query.to) rows = rows.where("a.published", "<", query.to);
  if (query.cursor) {
    // Row-value comparison, matching the (published DESC, id DESC) order — a
    // pair of scalar comparisons gets the mid-tie case wrong.
    rows = rows.where(
      sql<boolean>`(a.published, a.id) < (${new Date(query.cursor.published)}::timestamptz, ${query.cursor.articleId}::bigint)`,
    );
  }

  const fetched = await rows.execute();
  const hasMore = fetched.length > query.limit;
  const items = fetched.slice(0, query.limit).map(toArticle);

  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextCursor: hasMore && last ? { published: last.published, articleId: last.id } : null,
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
