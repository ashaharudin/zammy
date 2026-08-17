import { sql, type Kysely } from "kysely";
import type { Database } from "./database.js";

/**
 * The trailing corpus (ADR-0011): document frequency of `story_tokens` over a
 * rolling window of days, and the article count that makes a df a share.
 *
 * This is the "rare relative to what" answer the v2 linker needs. ADR-0009
 * measured rarity against ONE day's corpus, which the day bound made the only
 * available reading; a storyline unbounded in time cannot use it — the same
 * token would be rare on Monday and common on Wednesday, so whether Monday's
 * group joins would depend on which day it is asked. The corpus is now wide
 * enough that one loud day cannot blind the anchor to the story's own name,
 * and the ceiling stays a SHARE of it (ADR-0009's absolute-cap failure carries
 * forward unchanged).
 *
 * Two things about the counters, both deliberate:
 *
 *  - **They are approximate, and rebuildable.** `recordStoryDf` is an
 *    increment, not an idempotent upsert: a replayed ingest batch cannot
 *    re-count an article (only genuinely-new articles are offered), but a
 *    crash between the article's insert and this call loses one contribution
 *    forever. `rebuildStoryDf` recomputes any span from `articles`, which is
 *    the authority; nothing here is state that cannot be thrown away (§7.1).
 *  - **They are counted per ARTICLE, never per occurrence** — `story_tokens`
 *    is already distinct per article — the same discipline §10.3 applies to
 *    terms, and what makes ln(N/df) mean anything.
 *
 * `day` is a YYYY-MM-DD key in the APP_TIMEZONE calendar, computed by the
 * caller: storage does not own the app's idea of a day (§10.1), and passing it
 * in keeps this file free of Intl.
 */

/** The corpus a language with no declared language is counted in. */
export const UNKNOWN_LANGUAGE = "";

/** `articles.language` as this table keys it. */
export function dfLanguageKey(language: string | null): string {
  return language ?? UNKNOWN_LANGUAGE;
}

/** One article's contribution: its distinct story tokens, in its day-language. */
export interface StoryDfContribution {
  /** YYYY-MM-DD in the app's calendar. */
  day: string;
  language: string | null;
  tokens: readonly string[];
}

/**
 * What the linker asks the trailing corpus: how many of the window's articles
 * carry each token, and how many articles the window holds at all.
 *
 * `df` omits tokens the window never saw. A missing token is df 0 — rarer than
 * anything present — and the linker's floor is what decides whether that is
 * allowed to anchor; recording it as 1 here would quietly make the two cases
 * indistinguishable.
 */
export interface TrailingCorpus {
  /** Articles in the window, for the language asked about. */
  size: number;
  df: Map<string, number>;
}

/**
 * Fold a batch of articles into the window's counters, in one transaction.
 *
 * Aggregated in memory first: an upstream page creates ~8 articles carrying
 * ~30 tokens each, and 240 single-row upserts on the sync-fill path is the
 * shape ADR-0009 already measured blowing the §6.3 deadline. Two statements
 * instead, whatever the batch.
 */
export async function recordStoryDf(
  db: Kysely<Database>,
  contributions: readonly StoryDfContribution[],
): Promise<void> {
  if (contributions.length === 0) return;

  const tokenRows = new Map<string, { day: string; language: string; token: string; df: number }>();
  const corpusRows = new Map<string, { day: string; language: string; articles: number }>();

  for (const contribution of contributions) {
    const language = dfLanguageKey(contribution.language);
    const corpusKey = `${contribution.day}\u0000${language}`;
    const corpus = corpusRows.get(corpusKey);
    if (corpus) corpus.articles += 1;
    else corpusRows.set(corpusKey, { day: contribution.day, language, articles: 1 });

    // Distinct within the article: `story_tokens` is built distinct, but a
    // caller handing us a raw token list must not be able to inflate a df.
    for (const token of new Set(contribution.tokens)) {
      const key = `${corpusKey}\u0000${token}`;
      const row = tokenRows.get(key);
      if (row) row.df += 1;
      else tokenRows.set(key, { day: contribution.day, language, token, df: 1 });
    }
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("story_corpus_days")
      .values([...corpusRows.values()])
      .onConflict((oc) =>
        oc.columns(["day", "language"]).doUpdateSet((eb) => ({
          articles: sql<number>`story_corpus_days.articles + ${eb.ref("excluded.articles")}`,
        })),
      )
      .execute();

    if (tokenRows.size === 0) return;
    await trx
      .insertInto("story_token_days")
      .values([...tokenRows.values()])
      .onConflict((oc) =>
        oc.columns(["day", "language", "token"]).doUpdateSet((eb) => ({
          df: sql<number>`story_token_days.df + ${eb.ref("excluded.df")}`,
        })),
      )
      .execute();
  });
}

/**
 * The df of a specific token set over `[from, to]` inclusive day keys, plus
 * the window's corpus size.
 *
 * Two statements rather than a join: the corpus size does not depend on the
 * tokens, and a join would recompute it per token. Read-only and safe for the
 * threshold sweep to call over any historical span.
 */
export async function readStoryDf(
  db: Kysely<Database>,
  input: {
    language: string | null;
    /** Inclusive YYYY-MM-DD bounds. */
    from: string;
    to: string;
    tokens: readonly string[];
  },
): Promise<TrailingCorpus> {
  const language = dfLanguageKey(input.language);

  const corpus = await db
    .selectFrom("story_corpus_days")
    .select((eb) => eb.fn.sum<string>("articles").as("articles"))
    .where("language", "=", language)
    .where("day", ">=", input.from)
    .where("day", "<=", input.to)
    .executeTakeFirst();

  const size = Number(corpus?.articles ?? 0);
  const tokens = [...new Set(input.tokens)];
  if (tokens.length === 0) return { size, df: new Map() };

  const rows = await db
    .selectFrom("story_token_days")
    .select(["token", (eb) => eb.fn.sum<string>("df").as("df")])
    .where("language", "=", language)
    .where("day", ">=", input.from)
    .where("day", "<=", input.to)
    .where("token", "in", tokens)
    .groupBy("token")
    .execute();

  return { size, df: new Map(rows.map((row) => [row.token, Number(row.df)])) };
}

/**
 * Recompute a span's counters from `articles`, which is the authority.
 *
 * One SQL pass per call — the day key is derived in Postgres by
 * `AT TIME ZONE`, agreeing with `zonedDayKey` because both read the same IANA
 * database. Rebuilding replaces the span wholesale, so it heals a lost
 * increment, an interrupted backfill, and a re-tokenized window alike; it is
 * also how the table is first filled over an archive that predates it.
 *
 * `from`/`to` are UTC instants, not day keys: the boundary of a local day is
 * an instant, and choosing rows by their `published` is what makes the
 * delete-then-insert cover exactly the days it recomputes.
 */
export async function rebuildStoryDf(
  db: Kysely<Database>,
  input: { from: Date; to: Date; timeZone: string },
): Promise<{ days: number; tokens: number; articles: number }> {
  const result = await db.transaction().execute(async (trx) => {
    const dayKey = sql<string>`to_char(a.published at time zone ${input.timeZone}, 'YYYY-MM-DD')`;
    const language = sql<string>`coalesce(a.language, ${UNKNOWN_LANGUAGE})`;

    // Delete by the same derived key the insert uses, so a span whose edges
    // fall mid-day cannot leave half of a rewritten day behind.
    const spanDays = sql`
      select distinct to_char(published at time zone ${input.timeZone}, 'YYYY-MM-DD') as day
      from articles
      where published >= ${input.from} and published < ${input.to}
    `;
    await sql`delete from story_token_days where day in (${spanDays})`.execute(trx);
    await sql`delete from story_corpus_days where day in (${spanDays})`.execute(trx);

    // The whole day is recomputed, not just the requested slice — a day the
    // span clips would otherwise be rewritten to a fraction of itself, which
    // is worse than leaving it stale.
    const scope = sql`
      to_char(a.published at time zone ${input.timeZone}, 'YYYY-MM-DD') in (${spanDays})
    `;

    const corpus = await sql<{ count: string }>`
      insert into story_corpus_days (day, language, articles)
      select ${dayKey}, ${language}, count(*)
      from articles a
      where ${scope}
      group by 1, 2
      returning 1 as count
    `.execute(trx);

    const tokens = await sql<{ count: string }>`
      insert into story_token_days (day, language, token, df)
      select ${dayKey}, ${language}, t.token, count(distinct a.id)
      from articles a, lateral unnest(a.story_tokens) as t(token)
      where ${scope}
      group by 1, 2, 3
      returning 1 as count
    `.execute(trx);

    const total = await trx
      .selectFrom("story_corpus_days")
      .select((eb) => eb.fn.sum<string>("articles").as("articles"))
      .executeTakeFirst();

    return {
      days: corpus.rows.length,
      tokens: tokens.rows.length,
      articles: Number(total?.articles ?? 0),
    };
  });

  // MEASURED, and not an optimization: on the dev archive a lookup over a
  // freshly-rebuilt table took 19.9ms and 1.3ms after `ANALYZE` — without
  // statistics the planner has no reason to believe the (language, token, day)
  // index beats a scan, and the linker asks this question once per arriving
  // group. Autovacuum would get there eventually; a bulk rebuild is exactly
  // the case where "eventually" is after the next thousand lookups.
  await sql`analyze story_token_days, story_corpus_days`.execute(db);

  return result;
}

/**
 * Drop day buckets the window can no longer reach. Derived rows, rebuildable
 * from `articles` — deleting them is not what ADR-0001 guards, and since the
 * term cloud's `term_snapshots` went (ADR-0013) this is the only prune left.
 */
export async function pruneStoryDf(
  db: Kysely<Database>,
  input: { before: string },
): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const tokens = await trx
      .deleteFrom("story_token_days")
      .where("day", "<", input.before)
      .executeTakeFirst();
    await trx.deleteFrom("story_corpus_days").where("day", "<", input.before).execute();
    return Number(tokens.numDeletedRows ?? 0);
  });
}
