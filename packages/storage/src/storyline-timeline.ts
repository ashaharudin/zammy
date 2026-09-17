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
 *
 * That scoping is **clause 1 of the representative rule** — "among the members
 * that matched that search" (CONTEXT.md). The other three clauses are code in
 * `@zammy/representative`; this one is a join and stays here, so the two halves
 * meet at a contract rather than in a shared function: whatever this read
 * returns as a slot's members is exactly what may be promoted to its headline.
 * Widening the join widens the headline, silently and everywhere.
 */

/** One storyline-day: what the reader pages over. */
export interface StorylineSlot {
  storylineId: string;
  /** YYYY-MM-DD in APP_TIMEZONE — the slot's day, and half its identity. */
  dayKey: string;
  /** That day's earliest article across the storyline: the keyset axis. */
  published: string;
  /**
   * Members this topic can see, newest first. Never empty.
   *
   * Plain articles, because the group each belongs to now rides on the article
   * itself (`Article.groupId`). The wrapper that used to carry it alongside
   * held the same bigint twice, and two copies of one fact are two chances to
   * read the stale one.
   */
  members: Article[];
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
  /**
   * The storyline view's subjects — already alias-resolved by the caller, and
   * already folded to a set. Several, because a view may hold more than one
   * arc (ADR-0028): their days share the one keyset, so the page comes out in
   * time order across all of them rather than as one list per arc.
   */
  storylineIds?: readonly string[];
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
 * view scopes to one or more storylines and every article in them. Splitting them would
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
      ${
        query.storylineIds && query.storylineIds.length > 0
          ? sql`and sd.storyline_id in (${sql.join(query.storylineIds.map((id) => sql`${id}::uuid`))})`
          : sql``
      }
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

  const bySlot = new Map<string, Article[]>();
  for (const row of members) {
    const member = toArticle(row);
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
 * One storyline as a page NAMES it: what a reader needs to tell two arcs apart
 * and open one. The shared contract's `StorylineSummary`, before it is parsed.
 */
export interface StorylineSummaryRow {
  id: string;
  label: string | null;
  status: StorylineStatus;
  spanFrom: string;
  spanTo: string;
  /** Member articles over the storyline's whole life. */
  size: number;
}

/**
 * Which storylines each of these GROUPS is filed in, plus the storylines that
 * answer names.
 *
 * A SECOND READ, deliberately, and this is the file's own argument about the
 * hot path applied rather than ignored: the keyset scan above is scoped so that
 * a slot's members are the ones that matched the search, and "whatever this read
 * returns as a slot's members is exactly what may be promoted to its headline".
 * Widening its join to carry membership would widen the headline with it. So
 * membership is asked separately, of the groups the page already settled on,
 * over the reverse index `storyline_groups (group_id)` that migration 0007
 * created for exactly this question.
 *
 * Only groups filed in MORE THAN ONE storyline come back. A group in one is the
 * common case by a wide margin, and its one arc is the arc of whatever slot it
 * appears in — already on the wire — so a row for it would be a row reporting no
 * news (`groupStorylines` in `@zammy/shared` is where that reading lives).
 *
 * Three exclusions, all of them ADR-0011's rather than this function's:
 *
 *  - **provisional** — a storyline-of-one is invisible as a storyline, which is
 *    the same reason a provisional slot reaches the browser with `storyline:
 *    null`. Naming one as a crossing would be the first place the UI called it
 *    a story.
 *  - **aliases** (`merged_into is not null`) — belt and braces. `mergeStorylines`
 *    deletes the loser's `storyline_groups` rows, so an alias should hold no
 *    membership at all; a row that survived one would otherwise name a UUID that
 *    resolves elsewhere.
 *  - **storylines with no covered day** — impossible for a promoted arc, since
 *    every attach re-derives `storyline_days`, but the join enforces it anyway,
 *    and the reconciliation below is what keeps the map from naming a storyline
 *    the directory cannot describe.
 *
 * UNLABELLED promoted storylines are NOT excluded, unlike `findSurfacedStorylines`
 * which refuses to offer one. The difference is that this is not an offer: a
 * label-less arc is a valid thing to RENDER (ADR-0011's Labels — a promoted
 * storyline whose label generation failed renders label-less rather than not at
 * all), and it may be the arc a slot is being READ under, where dropping it
 * would silently take a row's own tick away. Whether an unnamed arc is worth
 * OFFERING as a destination is presentation's question, asked where the answer
 * can look at the label.
 */
export interface GroupMemberships {
  /** Group id → the storylines it is filed in, unordered. Never a single. */
  byGroup: Map<string, string[]>;
  /** Every storyline named in `byGroup`, and nothing else. */
  storylines: StorylineSummaryRow[];
}

export async function readGroupMemberships(
  db: Kysely<Database>,
  groupIds: readonly string[],
): Promise<GroupMemberships> {
  const unique = [...new Set(groupIds)];
  if (unique.length === 0) return { byGroup: new Map(), storylines: [] };

  const { rows: memberships } = await sql<{ group_id: string; storyline_ids: string[] }>`
    select sg.group_id, array_agg(sg.storyline_id::text) as storyline_ids
    from storyline_groups sg
    join storylines s on s.id = sg.storyline_id
    where sg.group_id in (${sql.join(unique.map((id) => sql`${id}::bigint`))})
      and s.merged_into is null
      and s.status <> 'provisional'
    group by sg.group_id
    having count(*) > 1
  `.execute(db);
  if (memberships.length === 0) return { byGroup: new Map(), storylines: [] };

  const named = [...new Set(memberships.flatMap((row) => row.storyline_ids))];
  const storylines = await describeStorylines(db, named);

  // Reconcile rather than trust: the contract is that every id in `byGroup` is
  // described in `storylines`, and a storyline the second statement could not
  // describe — no covered day, or deleted between the two — must not be left as
  // a UUID the browser can render a tick for and never a name. Dropping it can
  // take a group back down to one arc, which is then a group with nothing to
  // report and no entry at all.
  const describable = new Set(storylines.map((storyline) => storyline.id));
  const byGroup = new Map<string, string[]>();
  for (const row of memberships) {
    const ids = row.storyline_ids.filter((id) => describable.has(id));
    if (ids.length > 1) byGroup.set(String(row.group_id), ids);
  }
  // Same direction back: a storyline whose only groups were dropped above
  // describes nothing on this page.
  const kept = new Set([...byGroup.values()].flat());
  return { byGroup, storylines: storylines.filter((storyline) => kept.has(storyline.id)) };
}

/**
 * The storylines behind a set of UUIDs, as a page names them.
 *
 * The same five facts `findSurfacedStorylines` reports and the same aggregate
 * behind them, asked by ID instead of by keyword — the size subquery counts
 * member articles per storyline, which is a fact about the story rather than
 * about whatever put it on this page.
 *
 * Exported for the storyline VIEW, which names its own subjects in the same
 * list a search names what it surfaced (`TimelinePage.storylines`) and, since
 * a view may hold several arcs (ADR-0028), needs them described in one
 * statement rather than one count per arc. Not `readStorylineSummaries`: that
 * name is taken by the day SENTENCES (`storyline-summaries.ts`), and a summary
 * here is the wire's `StorylineSummary` — a description, not prose. A
 * storyline with no covered day is
 * absent from the answer — the join enforces it — so callers must not read the
 * result's length as the input's.
 */
export async function describeStorylines(
  db: Kysely<Database>,
  ids: readonly string[],
): Promise<StorylineSummaryRow[]> {
  if (ids.length === 0) return [];
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
    where s.id in (${sql.join(ids.map((id) => sql`${id}::uuid`))})
    group by s.id, s.label, s.status
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
 * Storylines a SEARCH surfaces: those whose own vocabulary contains every
 * keyword (ADR-0011 — "search keywords ⊆ profile tokens", widened to the label).
 *
 * Two places a storyline says what it is about, and a keyword may be found in
 * either: its **profile tokens**, the words half its member groups carry — two
 * of them at minimum, since ADR-0026 — and
 * its **label words**, the words the model chose to name it by. The label is not
 * a restatement of the profile — the majority rule means a word only a minority
 * of groups use is absent from the profile even when it is the very word that
 * names the event, and "Fort Hood Crash" surfaced for neither `hood` nor
 * `crash` while both sat in the label on screen. Reading only the profile also
 * made the cloud a one-way door: a label the reader was just shown, typed back
 * in, found nothing.
 *
 * One spelling of the keyword answers both columns, and that is the whole
 * reason `label_words` is a column. `normalizeLabel` folds a label with
 * `trimWordPunctuation`, `foldDiacritics`, `singular` — the same three steps in order
 * the corpus ran into `story_tokens` — so both vocabularies hold the same
 * spelling of the same word and both conjuncts are a GIN `@>`. Splitting the
 * label in SQL on read would have been free of a write and a backfill, and
 * would have cost a second definition of "the label's words" that drifts
 * silently from this one (migration 0016).
 *
 * Containment, not overlap, and containment per KEYWORD across both
 * vocabularies rather than within one — "fausto hawaii" surfaces the storm
 * whose label says Fausto and whose profile says hawaii. A search for "fausto
 * hawaii" should not surface every storyline that has ever said "hawaii"; the
 * GIN index answers `@>` as readily as `&&`, so the stricter reading costs
 * nothing on the profile side. Aliases are excluded — a pointer has no profile
 * — and provisional storylines with them: a storyline-of-one is not a story to
 * surface, it is the slot itself.
 *
 * UNLABELLED storylines are excluded too, and that one was learned by looking:
 * eight pills reading "unlabelled storyline" is what the browser showed while
 * the backfill's labelling pass was still running. A label-less storyline is a
 * valid thing to RENDER — its slots simply carry no gutter label (ADR-0011) —
 * but it is not a thing to OFFER, because a surfacing pill is a name plus a
 * size and without the name there is nothing for the reader to choose between.
 * It is also, now, the only storyline whose `label_words` are empty by right.
 */
export async function findSurfacedStorylines(
  db: Kysely<Database>,
  input: { keywords: readonly string[]; limit: number },
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
  if (input.keywords.length === 0) return [];

  // One conjunct per keyword: found in the profile, or found in the label. Both
  // sides are `@>` over a `text[]` column, so both are answered by a GIN index
  // (`storylines_profile_tokens_idx`, `storylines_label_words_idx`) and the
  // planner reaches for a BitmapOr — which it has to, since either vocabulary
  // may satisfy a keyword and neither index alone can answer the predicate.
  //
  // An empty keyword matches nothing on either side, which is the conservative
  // reading: it means the caller's fold consumed the whole word, and a keyword
  // that survives as no word must not silently widen the search.
  const matches = sql.join(
    input.keywords.map(
      (keyword) => sql`(
        s.profile_tokens @> array[${keyword}]::text[]
        or s.label_words @> array[${keyword}]::text[]
      )`,
    ),
    sql` and `,
  );

  // The match is settled over `storylines` alone before any day row is touched,
  // so the predicate runs once per candidate storyline rather than once per
  // covered DAY of one. The size subquery counts member ARTICLES, and counts
  // them per storyline rather than per matched search — a storyline's size is a
  // fact about the story, not about the words that found it.
  const { rows } = await sql<{
    id: string;
    label: string | null;
    status: StorylineStatus;
    span_from: Date;
    span_to: Date;
    size: string;
  }>`
    with matched as (
      select s.id, s.label, s.status
      from storylines s
      where s.merged_into is null
        and s.status <> 'provisional'
        and s.label is not null
        and ${matches}
    )
    select m.id, m.label, m.status,
           min(d.day_slot_published) as span_from,
           max(d.day_slot_published) as span_to,
           (select count(*) from storyline_groups sg
              join articles a on a.group_id = sg.group_id
             where sg.storyline_id = m.id) as size
    from matched m
    join storyline_days d on d.storyline_id = m.id
    group by m.id, m.label, m.status
    order by max(d.day_slot_published) desc, m.id
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
    groupId: String(row.group_id),
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
