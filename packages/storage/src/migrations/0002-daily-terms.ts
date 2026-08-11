import { sql, type Kysely } from "kysely";

/**
 * The §10.4 wordcloud schema, verbatim. `daily_terms` is a day's recomputed
 * aggregate — replaced wholesale on each sample, frozen once the day closes —
 * and `term_baseline` is the trailing per-term mean that suppresses perennial
 * news vocabulary (§10.3).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE daily_terms (
      day          date    NOT NULL,
      language     text    NOT NULL,
      term         text    NOT NULL,
      is_bigram    boolean NOT NULL,
      df_articles  int     NOT NULL,
      df_domains   int     NOT NULL,
      score        real    NOT NULL,
      PRIMARY KEY (day, language, term)
    )
  `.execute(db);
  await sql`
    CREATE INDEX daily_terms_top_idx ON daily_terms (day, language, score DESC)
  `.execute(db);

  await sql`
    CREATE TABLE term_baseline (
      language   text NOT NULL,
      term       text NOT NULL,
      mean_df    real NOT NULL,
      updated_on date NOT NULL,
      PRIMARY KEY (language, term)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS term_baseline`.execute(db);
  await sql`DROP TABLE IF EXISTS daily_terms`.execute(db);
}
