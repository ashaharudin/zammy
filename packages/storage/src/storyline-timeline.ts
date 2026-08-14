import { sql, type Kysely } from "kysely";
import { Article, type Cursor } from "@zammy/shared";
import { hexToBytea, type Database, type StorylineStatus } from "./database.js";

/**
 * The storylines-v2 timeline read (ADR-0011): keyset pagination over
 * STORYLINE-DAYS.
 *
 * A storyline is unbounded in time; the thing the reader pages over is not. Each
 * day a storyline has coverage it takes one fresh slot on that day, so no slot
 * ever spans days and the keyset survives unchanged in shape — just moved onto
 * `(day_slot_published, storyline_id)` in `storyline_days`.
 *
 * This puts the first real join in the hot read path, superseding the LETTER of
 * ADR-0002's "one index scan with no join". Its spirit is what mattered and is
 * preserved: position is precomputed at write time by `refreshDaySlots`, step
 * one of the read is still a pure index scan over a keyset, and reads never
 * re-sort. What the join adds is membership, which the old model denormalized
 * onto every article row and could only afford because a storyline was
 * day-bounded.
 *
 * Position is GLOBAL (`day_slot_published`, that day's earliest article across
 * the whole storyline) while members are per-TOPIC — exactly the split the old
 * read made, and for the same reason: a global headline could surface an
 * article that never matched what the user searched and hide the matching one
 * under "related" (§14.3).
 */

/** One member of a slot, with the group it belongs to. */
export interface StorylineSlotMember {
  article: Article;
  groupId: string;
}

/** One storyline-day: what the reader pages over. */
export interface StorylineSlot {
  storylineId: string;
  /** YYYY-MM-DD in APP_TIMEZONE — the slot's day, and half its identity. */
  dayKey: string;
  /** That day's earliest article across the storyline: the keyset axis. */
  published: string;
  /** Members this topic can see, newest first. Never empty. */
  members: StorylineSlotMember[];
  label: string | null;
  status: StorylineStatus;
  /** The storyline's whole span, for the label-collision disambiguator. */
  spanFrom: string;
  spanTo: string;
}

export interface StorylineTimelinePage {
  items: StorylineSlot[];
  nextCursor: Cursor | null;
  hasMore: boolean;
}

export interface StorylineTimelineQuery {
  /** sha256 hex fingerprint of the topic, or null for the storyline view. */
  fingerprint: string | null;
  /** The storyline view's subject — already alias-resolved by the caller. */
  storylineId?: string;
  from?: Date;
  to?: Date;
  cursor?: Cursor;
  limit: number;
  /** The calendar `day_key` was bucketed by, so the read agrees with the write. */
  timeZone: string;
}

/**
 * A page of storyline-days.
 *
 * Two shapes in one function because they differ by a predicate, not by
 * structure: the ordinary timeline scopes to a topic's articles, the storyline
 * view scopes to one storyline and every article in it. Splitting them would
 * mean two keyset implementations to keep in step, which is the bug this
 * codebase has already paid for once (§7.4).
 */
export async function readStorylineTimelinePage(
  db: Kysely<Database>,
  query: StorylineTimelineQuery,
): Promise<StorylineTimelinePage> {
  const fingerprint = query.fingerprint ? hexToBytea(query.fingerprint) : null;
  const dayOf = sql<string>`to_char(a.published at time zone ${query.timeZone}, 'YYYY-MM-DD')`;

  // Step 1 — the page of storyline-days, over the keyset axis.
  //
  // The join from articles to `storyline_days` is what makes "a group in two
  // storylines" behave: the group's article matches a day row in EACH of its
  // storylines, so it fans out to two slots and both are paged. Duplication is
  // accepted by ADR-0011 and this is where it becomes visible.
  const { rows: positions } = await sql<{
    storyline_id: string;
    day_key: string;
    day_slot_published: Date;
  }>`
    select distinct sd.storyline_id, sd.day_key, sd.day_slot_published
    from articles a
    join storyline_groups sg on sg.group_id = a.group_id
    join storyline_days sd
      on sd.storyline_id = sg.storyline_id and sd.day_key = ${dayOf}
    ${
      fingerprint
        ? sql`join topic_articles ta on ta.article_id = a.id and ta.fingerprint = ${fingerprint}`
        : sql``
    }
    where true
      ${query.storylineId ? sql`and sd.storyline_id = ${query.storylineId}::uuid` : sql``}
      ${query.from ? sql`and a.published >= ${query.from}` : sql``}
      ${query.to ? sql`and a.published < ${query.to}` : sql``}
      ${
        query.cursor
          ? sql`and (sd.day_slot_published, sd.storyline_id) <
                    (${new Date(query.cursor.published)}::timestamptz, ${query.cursor.articleId}::uuid)`
          : sql``
      }
    order by sd.day_slot_published desc, sd.storyline_id desc
    limit ${query.limit + 1}
  `.execute(db);

  const hasMore = positions.length > query.limit;
  const page = positions.slice(0, query.limit);
  if (page.length === 0) return { items: [], hasMore: false, nextCursor: null };

  // Step 2 — the members, per (storyline, day). Scoped exactly as step 1 was,
  // so a slot cannot show an article the position query did not count.
  const keys = page.map((slot) => `${slot.storyline_id}|${slot.day_key}`);
  const { rows: members } = await sql<
    Record<string, unknown> & { slot_key: string; group_id: string }
  >`
    select distinct a.*, sg.storyline_id || '|' || ${dayOf} as slot_key
    from articles a
    join storyline_groups sg on sg.group_id = a.group_id
    ${
      fingerprint
        ? sql`join topic_articles ta on ta.article_id = a.id and ta.fingerprint = ${fingerprint}`
        : sql``
    }
    where sg.storyline_id || '|' || ${dayOf} in (${sql.join(keys)})
    order by a.published desc, a.id desc
  `.execute(db);

  const bySlot = new Map<string, StorylineSlotMember[]>();
  for (const row of members) {
    const member = { article: toArticle(row), groupId: String(row.group_id) };
    const list = bySlot.get(row.slot_key);
    if (list) list.push(member);
    else bySlot.set(row.slot_key, [member]);
  }

  // Step 3 — the storylines themselves: label, status, and the span the
  // label-collision disambiguator needs. One statement for the whole page.
  const { rows: storylines } = await sql<{
    id: string;
    label: string | null;
    status: StorylineStatus;
    span_from: Date;
    span_to: Date;
  }>`
    select s.id, s.label, s.status,
           min(d.day_slot_published) as span_from,
           max(d.day_slot_published) as span_to
    from storylines s
    join storyline_days d on d.storyline_id = s.id
    where s.id in (${sql.join([...new Set(page.map((slot) => sql`${slot.storyline_id}::uuid`))])})
    group by s.id, s.label, s.status
  `.execute(db);
  const meta = new Map(storylines.map((row) => [row.id, row]));

  const items = page.map((slot): StorylineSlot => {
    const storyline = meta.get(slot.storyline_id);
    return {
      storylineId: slot.storyline_id,
      dayKey: slot.day_key,
      published: slot.day_slot_published.toISOString(),
      members: bySlot.get(`${slot.storyline_id}|${slot.day_key}`) ?? [],
      label: storyline?.label ?? null,
      status: storyline?.status ?? "provisional",
      spanFrom: (storyline?.span_from ?? slot.day_slot_published).toISOString(),
      spanTo: (storyline?.span_to ?? slot.day_slot_published).toISOString(),
    };
  });

  const last = page.at(-1);
  return {
    items,
    hasMore,
    nextCursor:
      hasMore && last
        ? {
            published: last.day_slot_published.toISOString(),
            articleId: last.storyline_id,
          }
        : null,
  };
}

/**
 * Storylines a SEARCH surfaces: those whose profile tokens contain every
 * keyword (ADR-0011 — "search keywords ⊆ profile tokens").
 *
 * Containment, not overlap. A search for "fausto hawaii" should surface the
 * storm, not every storyline that has ever said "hawaii"; the GIN index answers
 * `@>` as readily as `&&`, so the stricter reading costs nothing. Aliases are
 * excluded — a pointer has no profile — and provisional storylines with them:
 * a storyline-of-one is not a story to surface, it is the slot itself.
 *
 * UNLABELLED storylines are excluded too, and that one was learned by looking:
 * eight pills reading "unlabelled storyline" is what the browser showed while
 * the backfill's labelling pass was still running. A label-less storyline is a
 * valid thing to RENDER — its slots simply carry no gutter label (ADR-0011) —
 * but it is not a thing to OFFER, because a surfacing pill is a name plus a
 * size and without the name there is nothing for the reader to choose between.
 */
export async function findSurfacedStorylines(
  db: Kysely<Database>,
  input: { tokens: readonly string[]; limit: number },
): Promise<
  {
    id: string;
    label: string | null;
    spanFrom: string;
    spanTo: string;
    size: number;
    status: StorylineStatus;
  }[]
> {
  if (input.tokens.length === 0) return [];

  // The size subquery counts member ARTICLES, and counts them per storyline
  // rather than per matched search — a storyline's size is a fact about the
  // story, not about the words that found it.
  const { rows } = await sql<{
    id: string;
    label: string | null;
    status: StorylineStatus;
    span_from: Date;
    span_to: Date;
    size: string;
  }>`
    select s.id, s.label, s.status,
           min(d.day_slot_published) as span_from,
           max(d.day_slot_published) as span_to,
           (select count(*) from storyline_groups sg
              join articles a on a.group_id = sg.group_id
             where sg.storyline_id = s.id) as size
    from storylines s
    join storyline_days d on d.storyline_id = s.id
    where s.merged_into is null
      and s.status <> 'provisional'
      and s.label is not null
      and s.profile_tokens @> ${[...input.tokens]}::text[]
    group by s.id, s.label, s.status
    order by max(d.day_slot_published) desc, s.id
    limit ${input.limit}
  `.execute(db);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    spanFrom: row.span_from.toISOString(),
    spanTo: row.span_to.toISOString(),
    size: Number(row.size),
  }));
}

/**
 * Row → shared contract, validated on the way out — the same last gate the
 * old read applies (§5.2). `sql` returns loose rows, so the parse is doing
 * real work here rather than restating a type.
 */
function toArticle(row: Record<string, unknown>): Article {
  return Article.parse({
    id: String(row.id),
    url: row.url,
    title: row.title,
    description: row.description,
    author: row.author,
    imageUrl: row.image_url,
    language: row.language,
    categories: row.categories,
    sourceCategories: row.source_category,
    sourceDomain: row.source_domain,
    published: (row.published as Date).toISOString(),
    sightingCount: row.sighting_count,
    latestSeen: (row.latest_seen as Date).toISOString(),
  });
}
