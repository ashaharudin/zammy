import { sql, type ExpressionBuilder, type Kysely } from "kysely";
import type { Database, SummarySegment } from "./database.js";

/**
 * The reads and the one write behind the historical preserve (migration 0024,
 * ADR-0023, docs/STORYLINE-SUMMARIES.md).
 *
 * Everything time-shaped in here is UTC and says so. `storyline_days.day_key`
 * is an APP_TIMEZONE day and this module deliberately does not read it: a
 * sentence is written over a UTC day, and the view matches the two by DATE
 * LABEL rather than by instants (docs/STORYLINE-SUMMARIES.md, "Two calendars").
 *
 * **There are no quarters any more (ADR-0027).** A day is one sentence over its
 * own articles. `SummarySegment` still holds the five values and the rows
 * written under the old shape are still here, unread — see the migration and
 * `readArcDaySummaries`, which has always selected `segment = 'day'` alone.
 *
 * The day is expressed to Postgres as a HALF-OPEN INSTANT RANGE derived in
 * TypeScript, never as `to_char(published at time zone 'UTC') = '2026-08-29'`.
 * Two reasons, and the second is the one that bites: a formatted comparison
 * cannot use the index on `published`, and — since a `text` day key is a bucket
 * label rather than arithmetic (0007's argument) — the arithmetic belongs in one
 * place, `summaryDayBounds`, rather than in every query that mentions a day.
 */

/** YYYY-MM-DD of `instant` in UTC — this table's day key, always. */
export function summaryDayKey(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/**
 * `[midnight, next midnight)` in UTC for a day key.
 *
 * Half-open, matching every other span in this schema: an article published at
 * exactly midnight belongs to the day that starts there and to nothing else.
 */
export function summaryDayBounds(dayKey: string): { from: Date; to: Date } {
  const from = new Date(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw new Error(`not a day key: ${dayKey}`);
  return { from, to: new Date(from.getTime() + 86_400_000) };
}

/** A storyline-day that cleared the gate, with the numbers the gate read. */
export interface SummaryCandidateDay {
  storylineId: string;
  /** UTC. */
  dayKey: string;
  /** Articles across the member groups on that day. */
  articleCount: number;
  /** Distinct member groups — what separates coverage from syndication. */
  groupCount: number;
  /** The arc's label right now; copied onto the rows this candidate produces. */
  label: string | null;
}

/** Keyset position in the candidate walk: strictly ascending `(day, id)`. */
export interface SummaryCandidateCursor {
  dayKey: string;
  storylineId: string;
}

export interface SummaryCandidateOptions {
  /** Inclusive lower bound on `published`. */
  from: Date;
  /** Exclusive upper bound on `published`. */
  to: Date;
  /** Strictly-greater-than bar on the day's article count (`> 4` is 4 here). */
  minArticlesExclusive: number;
  /** At-least bar on distinct member groups. */
  minGroups: number;
  limit: number;
  after?: SummaryCandidateCursor;
  /** One arc only — the verification and per-storyline backfill runs. */
  storylineId?: string;
  /**
   * Which end of the window the walk starts from. `"oldest"` is the default and
   * is what the nightly pass has always done over the whole window.
   *
   * `"newest"` exists for ONE caller: the fresh-first phase the pass runs before
   * its oldest-first walk (ADR-0023's amendment). It is not a general-purpose
   * knob and not a preference — the two orders answer different questions, and
   * which of them a walk wants is decided by which days it is walking. See
   * `summaryPass`.
   *
   * The keyset flips with it: `after` is still "the last row I saw", so a
   * newest-first walk pages with `<` rather than `>`.
   */
  order?: "oldest" | "newest";
}

/**
 * Storyline-days worth preserving, oldest day first unless `order` says otherwise.
 *
 * (The first line used to read "newest first", which the paragraph below has
 * always contradicted. The code was right and the summary was wrong.)
 *
 * The gate is three clauses and each is a different question:
 *
 *  - `merged_into is null` and `status <> 'provisional'` — an alias is not a
 *    storyline and a provisional arc is one group that has not yet been shown
 *    to be a story at all (ADR-0011's Lifecycle). Neither has a history to
 *    preserve.
 *  - `count(*) > minArticlesExclusive` — enough material for a sentence to say
 *    something a headline does not.
 *  - `count(distinct group_id) >= minGroups` — enough SOURCES. The two counts
 *    are not the same test and the difference is the common case: one wire
 *    story syndicated six times is six articles in ONE group, which clears the
 *    volume bar and is not a day's coverage.
 *
 * Paged by a keyset rather than an offset because the caller walks the whole
 * window and its own writes do not move the cursor: unlike the label pass, what
 * this selects is a property of `articles`, which the summary pass never
 * touches — so the walk is stable even though the pass is writing throughout it.
 *
 * **OLDEST day first by default, which is the opposite of every other read
 * here.** The pass has a ceiling and the ceiling is reached: a night that cannot
 * drain its window has to leave something unwritten, and the order decides WHAT.
 * Newest first leaves the oldest end unwritten — and that end is about to fall
 * out of the window, after which nothing selects it again, so a bounded night
 * would silently lose the days it was closest to losing. Oldest first spends the
 * ceiling on exactly the days that are running out of chances; the newest day
 * is still there tomorrow, and is the day most likely to be rewritten anyway.
 *
 * That argument is sound and it is not the whole story, which is what the
 * amendment to ADR-0023 records: it assumes the deficit is spread evenly over
 * the window, and a promotion burst breaks that assumption by adding a whole
 * arc's back-history at once. Measured on 2026-09-16, six straight firings spent
 * 379 calls without reaching 09-14 or 09-15 at all. So the PASS now walks the
 * few freshest days first under a bounded share of its budget and then walks the
 * whole window this way — `order` is how it asks for the first of those. The
 * guarantee above is unchanged: the fresh phase cannot spend the night.
 */
export async function readSummaryCandidateDays(
  db: Kysely<Database>,
  options: SummaryCandidateOptions,
): Promise<SummaryCandidateDay[]> {
  const newestFirst = options.order === "newest";
  const { rows } = await sql<{
    storyline_id: string;
    day_key: string;
    article_count: number;
    group_count: number;
    label: string | null;
  }>`
    select sg.storyline_id,
           to_char(a.published at time zone 'UTC', 'YYYY-MM-DD') as day_key,
           count(*)::int                        as article_count,
           count(distinct sg.group_id)::int     as group_count,
           s.label
      from storyline_groups sg
      join articles   a on a.group_id = sg.group_id
      join storylines s on s.id = sg.storyline_id
     where s.merged_into is null
       and s.status <> 'provisional'
       and a.published >= ${options.from}
       and a.published <  ${options.to}
       ${
         options.storylineId
           ? sql`and sg.storyline_id = ${options.storylineId}::uuid`
           : sql``
       }
     group by sg.storyline_id, 2, s.label
    having count(*) > ${options.minArticlesExclusive}
       and count(distinct sg.group_id) >= ${options.minGroups}
       ${
         // The keyset, applied AFTER aggregation because the day key is an
         // aggregate's grouping column, not a row's. Tuple comparison, so the
         // tie-break on storyline id is the same one the ORDER BY makes — and
         // both sides are text, so the comparison and the ordering agree on
         // collation rather than one of them sorting as `uuid`.
         //
         // The comparison FOLLOWS the order: `after` means "the last row I saw",
         // so a descending walk pages with `<`. Leaving this as `>` under a
         // descending ORDER BY would re-read the first page for ever.
         options.after
           ? sql`and (to_char(a.published at time zone 'UTC', 'YYYY-MM-DD'), sg.storyline_id::text)
                     ${newestFirst ? sql`<` : sql`>`} (${options.after.dayKey}, ${options.after.storylineId})`
           : sql``
       }
     order by 2 ${newestFirst ? sql`desc` : sql`asc`},
              sg.storyline_id::text ${newestFirst ? sql`desc` : sql`asc`}
     limit ${options.limit}
  `.execute(db);

  return rows.map((row) => ({
    storylineId: row.storyline_id,
    dayKey: row.day_key,
    articleCount: row.article_count,
    groupCount: row.group_count,
    label: row.label,
  }));
}

/**
 * The days of ONE arc that qualify for a sentence and do not have one — the
 * click plane's whole plan (ADR-0027).
 *
 * The nightly pass discovers work by walking a window across every arc; this
 * answers the opposite question, asked about one arc at a reader's request, and
 * it is a different query rather than a narrowing of `readSummaryCandidateDays`
 * for two reasons that both matter:
 *
 *  - **No window.** ADR-0027 gives a click the arc's whole history, so there are
 *    no `from`/`to` bounds here at all. The nightly window exists to bound
 *    UNATTENDED spend across every arc; a click is one reader asking about one
 *    arc, and it is bounded by `limit` instead.
 *  - **`not exists` rather than a per-day read.** The pass reads a day's stored
 *    rows and calls `decideSpan`, which is right when it may also RETRY and
 *    RECOMPUTE. The click only ever writes a day that has no sentence, so asking
 *    the database that question once beats two round trips per day to be told to
 *    skip — an arc with forty summarised days would otherwise cost eighty
 *    queries to find nothing.
 *
 * **A row with a null `summary` counts as having one.** It is a REFUSAL — the
 * model was asked and would not answer (migration 0024's three states) — and
 * retrying refusals is the pass's business, bounded by `SUMMARY_MAX_ATTEMPTS`.
 * A click that retried them would spend an arc's whole attempt budget in as many
 * opens as it takes to click three times, on a table nothing can rebuild.
 *
 * **The alias chain, downward, exactly as `readArcDaySummaries` walks it.** The
 * preserve never follows a merge, so a winner's day can already be described by
 * a sentence written under a loser's id; membership DID follow the merge, so the
 * article gate reads the winner alone. Reading the winner's summaries alone
 * would re-buy sentences the arc already has, once per click, for ever.
 *
 * Newest day first: a reader who opened this arc is looking at its present, and
 * a bounded click should spend itself on the days they can see. The ordering
 * argument that makes the nightly pass go oldest-first is about days falling out
 * of a window, and there is no window here to fall out of.
 */
export async function readArcDaysAwaitingSummary(
  db: Kysely<Database>,
  options: {
    storylineId: string;
    minArticlesExclusive: number;
    minGroups: number;
    limit: number;
    /** Exclusive upper bound on `published` — the caller excludes today. */
    before: Date;
  },
): Promise<SummaryCandidateDay[]> {
  const { rows } = await sql<{
    storyline_id: string;
    day_key: string;
    article_count: number;
    group_count: number;
    label: string | null;
  }>`
    with recursive arc(id, depth) as (
      select id, 0 from storylines where id = ${options.storylineId}::uuid
      union all
      select loser.id, arc.depth + 1
      from storylines loser join arc on loser.merged_into = arc.id
      where arc.depth < 32
    ),
    -- The gate, as its own result set. Anti-joining in a HAVING clause would
    -- have to repeat the day-key expression to stay a grouping expression, and
    -- a second copy of that to_char() is the one place this query could drift
    -- out of agreement with itself about which day a row belongs to.
    days as (
      select sg.storyline_id,
             to_char(a.published at time zone 'UTC', 'YYYY-MM-DD') as day_key,
             count(*)::int                        as article_count,
             count(distinct sg.group_id)::int     as group_count,
             s.label
        from storyline_groups sg
        join articles   a on a.group_id = sg.group_id
        join storylines s on s.id = sg.storyline_id
       where sg.storyline_id = ${options.storylineId}::uuid
         -- The same two lifecycle clauses the nightly gate applies. A click can
         -- reach a provisional arc (the gutter renders label-less arcs and lets
         -- a reader click them), and a provisional arc is one group that has not
         -- been shown to be a story at all — no history to preserve yet.
         and s.merged_into is null
         and s.status <> 'provisional'
         and a.published < ${options.before}
       group by sg.storyline_id, 2, s.label
      having count(*) > ${options.minArticlesExclusive}
         and count(distinct sg.group_id) >= ${options.minGroups}
    )
    select d.storyline_id, d.day_key, d.article_count, d.group_count, d.label
      from days d
     where not exists (
       select 1
         from storyline_day_summaries existing
        where existing.storyline_id in (select id from arc)
          and existing.day_key = d.day_key
          and existing.segment = 'day'
     )
     order by d.day_key desc
     limit ${options.limit}
  `.execute(db);

  return rows.map((row) => ({
    storylineId: row.storyline_id,
    dayKey: row.day_key,
    articleCount: row.article_count,
    groupCount: row.group_count,
    label: row.label,
  }));
}

/** One article as a summary prompt renders it. */
export interface SummaryMember {
  title: string;
  description: string | null;
  published: Date;
  /** How syndicated this article is — the sample's ranking key. */
  sightingCount: number;
}

/** A day's coverage: how much of it there is, and the sample the model sees. */
export interface SummaryDayInput {
  /** Every article the arc holds on that UTC day, not just the sampled ones. */
  articleCount: number;
  /** Up to `sampleSize` of them, oldest first. */
  members: SummaryMember[];
}

/**
 * One storyline-day's articles: the whole count, and a sample of them.
 *
 * This replaced `readStorylineDaySegments` when the quarters went (ADR-0027).
 * The shape of the read is the same one it always made for a single quarter —
 * count everything, rank a sample — with the `partition by quarter` removed, so
 * the window functions now run over the day.
 *
 * The sample is `sighting_count DESC` — the dominant coverage of the day rather
 * than whatever happened to be published first — then re-sorted oldest first for
 * rendering, the same two-step the labeler's `selectLabelMembers` makes and for
 * the same reason: what to SHOW the model and what ORDER to show it in are
 * different questions.
 *
 * **The sample now carries the whole day's weight.** Under the quarters a busy
 * day reached the model as four samples and the day sentence was written over
 * their four sentences, so `sampleSize` bounded a quarter; here it bounds the
 * day, which is why `SUMMARY_DAY_SAMPLE` is not the 8 that `SUMMARY_SEGMENT_SAMPLE`
 * was. See its comment for the token arithmetic.
 */
export async function readStorylineDayArticles(
  db: Kysely<Database>,
  input: { storylineId: string; dayKey: string; sampleSize: number },
): Promise<SummaryDayInput> {
  const { from, to } = summaryDayBounds(input.dayKey);

  const { rows } = await sql<{
    day_count: number;
    title: string;
    description: string | null;
    published: Date;
    sighting_count: number;
  }>`
    with day_articles as (
      select a.id,
             a.title,
             a.description,
             a.published,
             a.sighting_count
        from storyline_groups sg
        join articles a on a.group_id = sg.group_id
       where sg.storyline_id = ${input.storylineId}::uuid
         and a.published >= ${from}
         and a.published <  ${to}
    ),
    ranked as (
      select d.*,
             count(*) over ()::int as day_count,
             row_number() over (
               order by d.sighting_count desc, d.published asc, d.id asc
             ) as rank
        from day_articles d
    )
    select day_count, title, description, published, sighting_count
      from ranked
     where rank <= ${input.sampleSize}
     order by published asc, id asc
  `.execute(db);

  return {
    // No rows is no coverage, and the count is what the caller compares against
    // a stored `article_count`. `rows[0]` rather than `rows.length`: the sample
    // is capped and the count is not.
    articleCount: rows[0]?.day_count ?? 0,
    members: rows.map((row) => ({
      title: row.title,
      description: row.description,
      published: row.published,
      sightingCount: row.sighting_count,
    })),
  };
}

/** A stored summary row, as the pass reads one back. */
export interface StoredSummary {
  segment: SummarySegment;
  /** Null when the model refused; `attempts` says how often it was asked. */
  summary: string | null;
  articleCount: number;
  attempts: number;
  segmented: boolean;
  modelId: string | null;
  generatedAt: Date;
}

/** What this storyline-day already holds. Keyed by segment at the caller. */
export async function readStorylineDaySummaries(
  db: Kysely<Database>,
  input: { storylineId: string; dayKey: string },
): Promise<StoredSummary[]> {
  const rows = await db
    .selectFrom("storyline_day_summaries")
    .select([
      "segment",
      "summary",
      "article_count",
      "attempts",
      "segmented",
      "model_id",
      "generated_at",
    ])
    .where("storyline_id", "=", input.storylineId)
    .where("day_key", "=", input.dayKey)
    .execute();

  return rows.map((row) => ({
    segment: row.segment,
    summary: row.summary,
    articleCount: row.article_count,
    attempts: row.attempts,
    segmented: row.segmented,
    modelId: row.model_id,
    generatedAt: row.generated_at,
  }));
}

export interface SummaryWrite {
  storylineId: string;
  dayKey: string;
  segment: SummarySegment;
  summary: string | null;
  articleCount: number;
  label: string | null;
  modelId: string | null;
  attempts: number;
  segmented: boolean;
  generatedAt: Date;
}

/**
 * Write one sentence, replacing what stood.
 *
 * An upsert rather than an insert because a row is rewritten twice over its
 * life for two different reasons — a segment that gained articles inside the
 * settling window, and a refusal being retried — and both are the same row
 * saying something new about the same span. What it must never do is accumulate
 * versions: the preserve is one sentence per span, and a history of attempts at
 * it is what `attempts` and `generated_at` carry.
 */
export async function writeStorylineDaySummary(
  db: Kysely<Database>,
  write: SummaryWrite,
): Promise<void> {
  await db
    .insertInto("storyline_day_summaries")
    .values({
      storyline_id: write.storylineId,
      day_key: write.dayKey,
      segment: write.segment,
      summary: write.summary,
      article_count: write.articleCount,
      label: write.label,
      model_id: write.modelId,
      attempts: write.attempts,
      segmented: write.segmented,
      generated_at: write.generatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["storyline_id", "day_key", "segment"]).doUpdateSet((eb) => ({
        // **A null summary never replaces one that stands, in SQL.**
        //
        // The caller already routes that case to `bumpSummaryAttempts`, so this
        // is defence rather than the mechanism — but it is defence against the
        // one race that is unrecoverable here. The caller decides "there is no
        // row to protect" from a read taken before its model call; a
        // concurrent writer that landed a sentence in between would otherwise
        // have it overwritten with a null, on the one table nothing can
        // rebuild. The article count travels with the summary for the same
        // reason: a count advanced past a sentence that was not rewritten
        // would retire a rewrite that is still owed.
        summary: eb.fn.coalesce("excluded.summary", "storyline_day_summaries.summary"),
        // Everything that DESCRIBES the sentence travels with the sentence.
        //
        // Keeping the summary while letting these through would be worse than
        // overwriting it outright, because the row would then look intact and
        // lie about itself: a preserved sentence attributed to a label and a
        // model that never produced it, and `segmented` flipped by a write that
        // did not place anything in time. `attempts` and nothing else is about
        // the ASK rather than the sentence, so it is the one field that lands
        // either way.
        article_count: keptWithSummary(eb, "article_count"),
        label: keptWithSummary(eb, "label"),
        model_id: keptWithSummary(eb, "model_id"),
        segmented: keptWithSummary(eb, "segmented"),
        generated_at: keptWithSummary(eb, "generated_at"),
        attempts: write.attempts,
      })),
    )
    .execute();
}

/**
 * Record one more ask that produced nothing, WITHOUT touching the sentence.
 *
 * The narrow write, and the reason it is narrow: a rewrite the model refused
 * must leave the standing sentence alone. A full upsert would have to carry the
 * old summary forward to do that, which is one place for the caller to get
 * wrong and lose a day of history to a night the API was down.
 */
export async function bumpSummaryAttempts(
  db: Kysely<Database>,
  input: { storylineId: string; dayKey: string; segment: SummarySegment },
): Promise<void> {
  await db
    .updateTable("storyline_day_summaries")
    .set((eb) => ({ attempts: eb("attempts", "+", 1) }))
    .where("storyline_id", "=", input.storylineId)
    .where("day_key", "=", input.dayKey)
    .where("segment", "=", input.segment)
    .execute();
}


/**
 * A column that is only overwritten when the incoming row carries a sentence.
 *
 * `case when excluded.summary is not null then excluded.<col> else
 * storyline_day_summaries.<col> end`, written once because five columns need
 * it and five hand-written copies is five chances to forget one.
 */
function keptWithSummary(
  eb: ExpressionBuilder<Database, "storyline_day_summaries">,
  column: "article_count" | "label" | "model_id" | "segmented" | "generated_at",
) {
  return eb
    .case()
    .when(eb.ref("excluded.summary" as never), "is not", null)
    .then(eb.ref(`excluded.${column}` as never))
    .else(eb.ref(`storyline_day_summaries.${column}` as never))
    .end();
}

/** Rows written for one arc, oldest day first — the CLI's report and the read path's. */
export async function readStorylineSummaries(
  db: Kysely<Database>,
  input: { storylineId: string; limit?: number },
): Promise<Array<StoredSummary & { dayKey: string; label: string | null }>> {
  const rows = await db
    .selectFrom("storyline_day_summaries")
    .selectAll()
    .where("storyline_id", "=", input.storylineId)
    .orderBy("day_key", "asc")
    .orderBy("segment", "asc")
    .limit(input.limit ?? 1_000)
    .execute();

  return rows.map((row) => ({
    dayKey: row.day_key,
    segment: row.segment,
    summary: row.summary,
    articleCount: row.article_count,
    attempts: row.attempts,
    segmented: row.segmented,
    modelId: row.model_id,
    label: row.label,
    generatedAt: row.generated_at,
  }));
}

/**
 * The DAY sentences an arc can be read under, `dayKey → summary` — what the
 * storyline view puts beside its day headings.
 *
 * Three narrowings, each of which is the difference between this read and
 * `readStorylineSummaries` above:
 *
 *  - **`segment = 'day'` only.** The four quarters are the day sentence's own
 *    input (docs/STORYLINE-SUMMARIES.md, "What the model is asked"), and the
 *    rail already cuts a day into parts of the READER's day — four UTC quarters
 *    drawn against four local parts would be two different divisions of one day
 *    sitting on top of each other. The day sentence is the one that answers the
 *    heading it goes under.
 *  - **`summary is not null`.** A refusal is a row, and it means the model was
 *    asked and would not answer; there is no deterministic fallback for prose
 *    (the migration's own argument), so what a reader gets is the heading they
 *    always had. Absent and refused read the same way here, on purpose — the
 *    difference matters to the pass, never to the page.
 *  - **the whole ALIAS CHAIN**, not just this id. A merge leaves these rows on
 *    the id they were written for and never rewrites them (migration 0024);
 *    the view resolves a bookmark FORWARD to the winner, so reading the winner's
 *    id alone would drop every sentence written before the merge — on days whose
 *    coverage the view is nonetheless drawing, because membership followed the
 *    merge even though the preserve did not.
 *
 * Two rows can therefore answer for one day: the winner's and a loser's, each
 * written over the coverage its own arc held. The higher `article_count` wins —
 * the sentence written over more of that day is the one that describes more of
 * it — and `generated_at` breaks the tie, newest first, because a later write
 * saw at least as much as an earlier one. `storyline_id` last so the answer is
 * stable across replays rather than left to the scan.
 *
 * `storylineId` must ALREADY be alias-resolved: this walks the chain downward
 * (who merged INTO me), which answers nothing when handed a loser.
 */
export async function readArcDaySummaries(
  db: Kysely<Database>,
  input: { storylineId: string },
): Promise<Map<string, string>> {
  // The alias walk, downward, with the same depth cap `resolveStoryline` uses
  // upward and for the same reason: no writer here can create a cycle, and the
  // cap bounds a corrupted chain to a bad answer rather than a hanging query.
  const { rows } = await sql<{ day_key: string; summary: string }>`
    with recursive arc(id, depth) as (
      select id, 0 from storylines where id = ${input.storylineId}::uuid
      union all
      select loser.id, arc.depth + 1
      from storylines loser join arc on loser.merged_into = arc.id
      where arc.depth < 32
    )
    select distinct on (day_key) day_key, summary
    from storyline_day_summaries
    where storyline_id in (select id from arc)
      and segment = 'day'
      and summary is not null
    order by day_key, article_count desc, generated_at desc, storyline_id
  `.execute(db);

  return new Map(rows.map((row) => [row.day_key, row.summary]));
}
