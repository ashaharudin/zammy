import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

/**
 * Wordcloud storage (ARCHITECTURE 10.4). Three rules from §10.1/§10.3 shape
 * this file, all of them consequences of the window rolling rather than
 * resetting (ADR-0008): the cloud is ONE row set per language and writes
 * replace it wholesale; the only thing that accumulates is an hourly history
 * of RAW counts, since a mean over weighted numbers would compare a term
 * against how recent it happened to be when last seen; and the baseline reads
 * that history strictly OLDER than the live window, because a snapshot taken
 * an hour ago shares 23/24ths of its corpus with the window being scored.
 */

export interface TrendingTerm {
  term: string;
  isBigram: boolean;
  /** True, uncapped, unweighted count — what the cloud displays (§10.3). */
  dfArticles: number;
  dfDomains: number;
  /** Recency-weighted, per-domain-capped — the size input. */
  weightedDf: number;
  score: number;
}

/** Replace the language's cloud wholesale, in one transaction. */
export async function replaceTrendingTerms(
  db: Kysely<Database>,
  input: {
    language: string;
    windowStart: Date;
    windowEnd: Date;
    terms: readonly TrendingTerm[];
  },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("trending_terms").where("language", "=", input.language).execute();

    if (input.terms.length === 0) return;
    await trx
      .insertInto("trending_terms")
      .values(
        input.terms.map((t) => ({
          language: input.language,
          term: t.term,
          is_bigram: t.isBigram,
          df_articles: t.dfArticles,
          df_domains: t.dfDomains,
          weighted_df: t.weightedDf,
          score: t.score,
          window_start: input.windowStart,
          window_end: input.windowEnd,
        })),
      )
      .execute();
  });
}

export async function readTrendingTerms(
  db: Kysely<Database>,
  input: { language: string; limit: number },
): Promise<TrendingTerm[]> {
  const rows = await db
    .selectFrom("trending_terms")
    .select(["term", "is_bigram", "df_articles", "df_domains", "weighted_df", "score"])
    .where("language", "=", input.language)
    .orderBy("score", "desc")
    .orderBy("term")
    .limit(input.limit)
    .execute();

  return rows.map((row) => ({
    term: row.term,
    isBigram: row.is_bigram,
    dfArticles: row.df_articles,
    dfDomains: row.df_domains,
    weightedDf: row.weighted_df,
    score: row.score,
  }));
}

/**
 * The scorer's input: the distinct ARTICLES published inside the rolling
 * window for a language (§10.1 corpus source 1 — everything already stored,
 * from any topic). Articles are already the sighting-collapsed unit, so the
 * 50×-re-emitted page appears once (§10.3). `published` comes with them: it
 * is what the recency weight reads.
 */
export async function readWindowCorpus(
  db: Kysely<Database>,
  input: { language: string; from: Date; to: Date },
): Promise<
  Array<{
    title: string;
    description: string | null;
    sourceDomain: string | null;
    published: Date;
  }>
> {
  const rows = await db
    .selectFrom("articles")
    .select(["title", "description", "source_domain", "published"])
    .where("language", "=", input.language)
    .where("published", ">=", input.from)
    .where("published", "<", input.to)
    .execute();

  return rows.map((row) => ({
    title: row.title,
    description: row.description,
    sourceDomain: row.source_domain,
    published: row.published,
  }));
}

/**
 * Record this recompute's RAW per-term counts under the hour it ran. Upsert,
 * not insert: two recomputes inside one hour keep a single observation, so a
 * busy hour cannot outvote a quiet one in the mean (§10.4).
 */
export async function recordTermSnapshot(
  db: Kysely<Database>,
  input: {
    language: string;
    bucketHour: Date;
    terms: readonly Pick<TrendingTerm, "term" | "dfArticles">[],
  },
): Promise<void> {
  if (input.terms.length === 0) return;
  await db
    .insertInto("term_snapshots")
    .values(
      input.terms.map((t) => ({
        bucket_hour: input.bucketHour,
        language: input.language,
        term: t.term,
        df_articles: t.dfArticles,
      })),
    )
    .onConflict((oc) =>
      oc.columns(["bucket_hour", "language", "term"]).doUpdateSet((eb) => ({
        df_articles: eb.ref("excluded.df_articles"),
      })),
    )
    .execute();
}

/** The hour `instant` falls in — the snapshot history's resolution. */
export function hourBucket(instant: Date): Date {
  const bucket = new Date(instant);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket;
}

/**
 * Recompute the trailing mean per term from the snapshot history.
 *
 * The range ends one WINDOW before `now` and reaches `baselineWindowDays`
 * back from there. The exclusion is the point: a snapshot taken less than a
 * window ago shares most of its corpus with the window being scored, so
 * including it would let a term suppress itself (§10.3).
 *
 * The divisor is the number of snapshots ACTUALLY RECORDED in the range, not
 * the number of hours in it. Sampling is visit-driven (§9), so a missing hour
 * means nobody looked, which is not an observation — while a term absent from
 * a recorded snapshot is a real zero. Dividing by elapsed hours would deflate
 * every baseline in proportion to how quiet the deployment is, which is
 * exactly when the suppressor is most needed.
 */
export async function refreshTermBaseline(
  db: Kysely<Database>,
  input: {
    language: string;
    now: Date;
    windowHours: number;
    baselineWindowDays: number;
  },
): Promise<void> {
  const until = new Date(input.now.getTime() - input.windowHours * 3_600_000);
  const from = new Date(until.getTime() - input.baselineWindowDays * 86_400_000);

  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("term_baseline").where("language", "=", input.language).execute();

    await sql`
      insert into term_baseline (language, term, mean_df, updated_at)
      select
        ${input.language},
        term,
        sum(df_articles)::real / (
          select greatest(count(distinct bucket_hour), 1)
          from term_snapshots
          where language = ${input.language}
            and bucket_hour >= ${from}
            and bucket_hour < ${until}
        ),
        ${input.now}
      from term_snapshots
      where language = ${input.language}
        and bucket_hour >= ${from}
        and bucket_hour < ${until}
      group by term
    `.execute(trx);
  });
}

export async function readTermBaseline(
  db: Kysely<Database>,
  language: string,
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("term_baseline")
    .select(["term", "mean_df"])
    .where("language", "=", language)
    .execute();
  return new Map(rows.map((row) => [row.term, row.mean_df]));
}

/**
 * Drop snapshots past the baseline's reach. The one derived table that grows
 * without bound (§7.5); deleting derived rows is not what ADR-0001 guards.
 */
export async function pruneTermSnapshots(
  db: Kysely<Database>,
  input: { before: Date },
): Promise<number> {
  const result = await db
    .deleteFrom("term_snapshots")
    .where("bucket_hour", "<", input.before)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
