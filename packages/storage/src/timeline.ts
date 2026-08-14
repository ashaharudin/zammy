import { sql, type Kysely, type Selectable } from "kysely";
import { Article, type Cursor } from "@zammy/shared";
import { hexToBytea, type ArticlesTable, type Database } from "./database.js";

/**
 * The timeline read (ARCHITECTURE 7.3): keyset pagination over STORYLINES.
 *
 * Deduplication is a property of the table, not a filter applied here — that is
 * the whole reason `articles` and `sightings` are separate. Keyset rather than
 * OFFSET because articles arrive continuously: rows cannot shift between pages
 * and cause duplicates or skips, and cost is constant regardless of depth.
 *
 * Grouping (§14.3) established the shape — a page is N write-time-materialized
 * slots read as one index scan, never N articles collapsed at read time, which
 * ADR-0002 rejected for making page size unpredictable and `hasMore`
 * unreliable. ADR-0009 moved the slot up one layer: a slot is now a STORYLINE
 * (a day's coverage of one story, groups clustered hub-and-spoke), paged over
 * `(storyline_published, storyline_id)`. A group that leads its own storyline
 * — which is what every group starts as — pages exactly as it did when slots
 * were groups, so a store with no clustering behaves as before.
 */

export interface TimelineQuery {
  /** sha256 hex fingerprint of the topic (§6.2). */
  fingerprint: string;
  /**
   * Window over an ARTICLE's published, inclusive `from`, exclusive `to`. A
   * storyline qualifies when any of its members does, and then arrives whole.
   */
  from?: Date;
  to?: Date;
  /** Resume after this `(published, id)` tuple; omitted on the first page. */
  cursor?: Cursor;
  /** Page size, in storylines. The API layer validates; positive integer. */
  limit: number;
}

/** One member of a slot, with the group it belongs to — the API layer's
 * representative choice and same-story/coverage split both need it. */
export interface SlotMember {
  article: Article;
  groupId: string;
}

/**
 * One timeline slot: a day's coverage of a story as this topic saw it.
 *
 * Which member holds the headline is NOT decided here. The representative is
 * per-topic and is an editorial call (§14.3, `source-authority.ts` in the API
 * layer); storage's job is to hand over the storyline's members and its
 * position.
 */
export interface TimelineSlot {
  /** The storyline's identity — its hub group's id, the cursor's id half. */
  id: string;
  /**
   * MIN(published) over the storyline: where the slot sits, and the time the
   * UI shows. Independent of which member holds the headline, so a later
   * tier-1 article changes the headline in place without moving the slot.
   */
  published: string;
  /** Members belonging to THIS topic, newest first. Never empty. */
  members: SlotMember[];
}

export interface TimelinePage {
  /** `storyline_published` DESC, `storyline_id` DESC — a total order upstream does not provide. */
  items: TimelineSlot[];
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

  // Step 1 — the page of storylines, over the keyset axis. Both selected
  // columns are functions of the storyline, so DISTINCT costs nothing beyond
  // folding its several members into the one row that represents it here.
  let positions = db
    .selectFrom("topic_articles as ta")
    .innerJoin("articles as a", "a.id", "ta.article_id")
    .select(["a.storyline_id as id", "a.storyline_published as published"])
    .distinct()
    .where("ta.fingerprint", "=", fingerprint)
    .orderBy("a.storyline_published", "desc")
    .orderBy("a.storyline_id", "desc")
    // One row past the page: the cheap, exact hasMore probe.
    .limit(query.limit + 1);

  // The window selects storylines by their MEMBERS' own `published`, not by
  // the slot's position. Filtering on the position would drop an article that
  // falls squarely inside the requested window because its storyline happens
  // to sit just before it — and coverage would then record that window as
  // fetched, so nothing would ever go looking for it again (§7.2). A slot
  // whose position predates `from` therefore appears, and sits at its true
  // position: honest about when the story was first reported.
  if (query.from) positions = positions.where("a.published", ">=", query.from);
  if (query.to) positions = positions.where("a.published", "<", query.to);
  if (query.cursor) {
    // Row-value comparison, matching the (published DESC, id DESC) order — a
    // pair of scalar comparisons gets the mid-tie case wrong.
    positions = positions.where(
      sql<boolean>`(a.storyline_published, a.storyline_id) < (${new Date(query.cursor.published)}::timestamptz, ${query.cursor.articleId}::bigint)`,
    );
  }

  const fetched = await positions.execute();
  const hasMore = fetched.length > query.limit;
  const page = fetched.slice(0, query.limit);
  if (page.length === 0) return { items: [], hasMore: false, nextCursor: null };

  // Step 2 — the members, for this topic only. A storyline is global, but a
  // global headline could surface an article that never matched what the user
  // searched and hide the matching one under "related" (§14.3) — the
  // invariant predates storylines and survives them.
  const members = await db
    .selectFrom("topic_articles as ta")
    .innerJoin("articles as a", "a.id", "ta.article_id")
    .selectAll("a")
    .where("ta.fingerprint", "=", fingerprint)
    .where(
      "a.storyline_id",
      "in",
      page.map((slot) => slot.id),
    )
    .orderBy("a.published", "desc")
    .orderBy("a.id", "desc")
    .execute();

  const bySlot = new Map<string, SlotMember[]>();
  for (const row of members) {
    const member = { article: toArticle(row), groupId: row.group_id };
    const list = bySlot.get(row.storyline_id);
    if (list) list.push(member);
    else bySlot.set(row.storyline_id, [member]);
  }

  const items = page.map((slot) => ({
    id: slot.id,
    published: slot.published.toISOString(),
    // Non-empty by construction: every id here came from a member row.
    members: bySlot.get(slot.id) ?? [],
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

/**
 * Enroll one storyline's articles in a topic (ADR-0010) — how a
 * `storylinePhrase` chip hands the story it names to the topic it opens,
 * so the search that phrase promises contains the slot it came from.
 *
 * §7.6 refuses a local search path, and this is not one: it resolves no
 * keywords and finds no articles. The caller names ONE storyline it is already
 * showing, and `tokens` is a GATE on that storyline rather than a query —
 * every keyword of the topic, folded the way `story_tokens` was folded, must
 * be present in the article. Without that gate `?q=bananas&storyline=…` would
 * be an open door onto any topic's membership; with it, the worst a crafted
 * link can do is enroll articles that do contain every word the user searched.
 *
 * Returns how many rows it INSERTED — zero means the topic already held them,
 * which is what lets a caller know whether a cached page can still be trusted.
 */
export async function attachStorylineToTopic(
  db: Kysely<Database>,
  params: {
    fingerprint: string;
    storylineId: string;
    tokens: readonly string[];
    /** The topic's language filter, or null for "all languages". Enforced
     * because it is part of what the topic IS, and an article whose language
     * is known and different never belonged in it. A null on the ARTICLE is
     * upstream not saying, which the ordinary fill enrolls too. */
    language: string | null;
  },
): Promise<number> {
  // A storyline id reaches here from a query string. It is a bigint column, so
  // anything else is a 500 waiting to happen rather than an empty result.
  if (!/^\d+$/.test(params.storylineId)) return 0;
  // An empty gate would enroll the storyline wholesale, which is the one thing
  // the gate exists to prevent.
  if (params.tokens.length === 0) return 0;

  const result = await sql`
    insert into topic_articles (fingerprint, article_id)
    select ${hexToBytea(params.fingerprint)}, a.id
    from articles a
    where a.storyline_id = ${params.storylineId}::bigint
      and a.story_tokens @> ${[...params.tokens]}::text[]
      and (${params.language}::text is null or a.language is null or a.language = ${params.language})
    on conflict (fingerprint, article_id) do nothing
  `.execute(db);

  return Number(result.numAffectedRows ?? 0n);
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
