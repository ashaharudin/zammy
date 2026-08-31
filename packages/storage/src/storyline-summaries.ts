import { sql, type ExpressionBuilder, type Kysely } from "kysely";
import type { Database, SummarySegment } from "./database.js";

/**
 * The reads and the one write behind the historical preserve (migration 0024,
 * ADR-0023, docs/STORYLINE-SUMMARIES.md).
 *
 * Everything time-shaped in here is UTC and says so. `storyline_days.day_key`
 * is an APP_TIMEZONE day and this module deliberately does not read it: the
 * segments are UTC quarters, so the day they add up to has to be the UTC day or
 * the fifth sentence covers a span the other four do not.
 *
 * The day is expressed to Postgres as a HALF-OPEN INSTANT RANGE derived in
 * TypeScript, never as `to_char(published at time zone 'UTC') = '2026-08-29'`.
 * Two reasons, and the second is the one that bites: a formatted comparison
 * cannot use the index on `published`, and — since a `text` day key is a bucket
 * label rather than arithmetic (0007's argument) — the arithmetic belongs in one
 * place, `summaryDayBounds`, rather than in every query that mentions a day.
 */

/** The four quarters, in the order a day reads. `day` is not one of them. */
export const SUMMARY_QUARTERS = ["night", "morning", "afternoon", "evening"] as const;

export type SummaryQuarter = (typeof SUMMARY_QUARTERS)[number];

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

/** Which quarter a UTC hour falls in. `floor(hour / 6)`, named. */
export function quarterOfUtcHour(hour: number): SummaryQuarter {
  const index = Math.floor(hour / 6);
  const quarter = SUMMARY_QUARTERS[index];
  if (quarter === undefined) throw new Error(`hour out of range: ${hour}`);
  return quarter;
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
}

/**
 * Storyline-days worth preserving, newest first.
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
 * **OLDEST day first, which is the opposite of every other read here.** The
 * pass has a ceiling and the ceiling is reached: a night that cannot drain its
 * window has to leave something unwritten, and the order decides WHAT. Newest
 * first leaves the oldest end unwritten — and that end is about to fall out of
 * the window, after which nothing selects it again, so a bounded night would
 * silently lose the days it was closest to losing. Oldest first spends the
 * ceiling on exactly the days that are running out of chances; the newest day
 * is still there tomorrow, and is the day most likely to be rewritten anyway.
 */
export async function readSummaryCandidateDays(
  db: Kysely<Database>,
  options: SummaryCandidateOptions,
): Promise<SummaryCandidateDay[]> {
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
         options.after
           ? sql`and (to_char(a.published at time zone 'UTC', 'YYYY-MM-DD'), sg.storyline_id::text)
                     > (${options.after.dayKey}, ${options.after.storylineId})`
           : sql``
       }
     order by 2 asc, sg.storyline_id::text asc
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

/** One populated quarter of a day: everything in it, and the sample of it. */
export interface SummarySegmentInput {
  segment: SummaryQuarter;
  /** Every article in the quarter, not just the sampled ones. */
  articleCount: number;
  /** Up to `sampleSize` of them, oldest first. */
  members: SummaryMember[];
}

/**
 * The day's articles, split into its populated quarters.
 *
 * Empty quarters are absent from the result rather than present and empty, which
 * is the whole skip rule expressed once, here, instead of at every caller.
 *
 * The sample is `sighting_count DESC` — the dominant coverage of the quarter
 * rather than whatever happened to be published first — then re-sorted oldest
 * first for rendering, the same two-step the labeler's `selectLabelMembers`
 * makes and for the same reason: what to SHOW the model and what ORDER to show
 * it in are different questions.
 */
export async function readStorylineDaySegments(
  db: Kysely<Database>,
  input: { storylineId: string; dayKey: string; sampleSize: number },
): Promise<SummarySegmentInput[]> {
  const { from, to } = summaryDayBounds(input.dayKey);

  const { rows } = await sql<{
    quarter: number;
    segment_count: number;
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
             a.sighting_count,
             (floor(extract(hour from (a.published at time zone 'UTC')) / 6))::int as quarter
        from storyline_groups sg
        join articles a on a.group_id = sg.group_id
       where sg.storyline_id = ${input.storylineId}::uuid
         and a.published >= ${from}
         and a.published <  ${to}
    ),
    ranked as (
      select d.*,
             count(*) over (partition by d.quarter)::int as segment_count,
             row_number() over (
               partition by d.quarter
               order by d.sighting_count desc, d.published asc, d.id asc
             ) as rank
        from day_articles d
    )
    select quarter, segment_count, title, description, published, sighting_count
      from ranked
     where rank <= ${input.sampleSize}
     order by quarter asc, published asc, id asc
  `.execute(db);

  const bySegment = new Map<SummaryQuarter, SummarySegmentInput>();
  for (const row of rows) {
    const segment = quarterOfUtcHour(row.quarter * 6);
    let entry = bySegment.get(segment);
    if (entry === undefined) {
      entry = { segment, articleCount: row.segment_count, members: [] };
      bySegment.set(segment, entry);
    }
    entry.members.push({
      title: row.title,
      description: row.description,
      published: row.published,
      sightingCount: row.sighting_count,
    });
  }

  // Chronological order of the quarters, not the order the rows arrived in.
  return SUMMARY_QUARTERS.map((segment) => bySegment.get(segment)).filter(
    (entry): entry is SummarySegmentInput => entry !== undefined,
  );
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
