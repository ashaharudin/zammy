import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

/**
 * Wordcloud storage (ARCHITECTURE 10.4). Three rules from §10.1/§10.3 shape
 * this file: a day's aggregate is RECOMPUTED, so writes replace rather than
 * append; a closed day freezes, so nothing here ever touches more than the
 * one day it was asked about; and the baseline is a trailing mean with
 * absent days counting zero — a term that spiked once must not carry the
 * baseline of a term that runs every day.
 */

export interface DailyTerm {
  term: string;
  isBigram: boolean;
  dfArticles: number;
  dfDomains: number;
  score: number;
}

/** Replace the (day, language) aggregate wholesale, in one transaction. */
export async function replaceDailyTerms(
  db: Kysely<Database>,
  input: { day: string; language: string; terms: readonly DailyTerm[] },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("daily_terms")
      .where("day", "=", sql<Date>`${input.day}::date`)
      .where("language", "=", input.language)
      .execute();

    if (input.terms.length === 0) return;
    await trx
      .insertInto("daily_terms")
      .values(
        input.terms.map((t) => ({
          day: input.day,
          language: input.language,
          term: t.term,
          is_bigram: t.isBigram,
          df_articles: t.dfArticles,
          df_domains: t.dfDomains,
          score: t.score,
        })),
      )
      .execute();
  });
}

export async function readDailyTerms(
  db: Kysely<Database>,
  input: { day: string; language: string; limit: number },
): Promise<DailyTerm[]> {
  const rows = await db
    .selectFrom("daily_terms")
    .select(["term", "is_bigram", "df_articles", "df_domains", "score"])
    .where("day", "=", sql<Date>`${input.day}::date`)
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
    score: row.score,
  }));
}

/**
 * Recompute the trailing mean per term over the `windowDays` days BEFORE
 * `upToDay` (exclusive — today's own counts must not suppress today). Terms
 * absent from the window fall out entirely rather than lingering at a stale
 * mean; dividing by the window length, not days-present, is what keeps a
 * one-day spike's baseline low enough to trend again (§10.3).
 */
export async function refreshTermBaseline(
  db: Kysely<Database>,
  input: { language: string; upToDay: string; windowDays: number },
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("term_baseline")
      .where("language", "=", input.language)
      .execute();

    await sql`
      insert into term_baseline (language, term, mean_df, updated_on)
      select
        ${input.language},
        term,
        sum(df_articles)::real / ${input.windowDays},
        ${input.upToDay}::date
      from daily_terms
      where language = ${input.language}
        and day >= ${input.upToDay}::date - ${input.windowDays}::int
        and day < ${input.upToDay}::date
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
 * The scorer's input: the day's distinct ARTICLES for a language (§10.1
 * corpus source 1 — everything already stored, from any topic). Articles are
 * already the sighting-collapsed unit, so the 50×-re-emitted page appears
 * once (§10.3).
 */
export async function readDayCorpus(
  db: Kysely<Database>,
  input: { language: string; from: Date; to: Date },
): Promise<Array<{ title: string; description: string | null; sourceDomain: string | null }>> {
  const rows = await db
    .selectFrom("articles")
    .select(["title", "description", "source_domain"])
    .where("language", "=", input.language)
    .where("published", ">=", input.from)
    .where("published", "<", input.to)
    .execute();

  return rows.map((row) => ({
    title: row.title,
    description: row.description,
    sourceDomain: row.source_domain,
  }));
}
