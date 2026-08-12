import { sql, type Kysely } from "kysely";

/**
 * The §10.4 rolling-window wordcloud schema (ADR-0008). `daily_terms` and its
 * day key go: the cloud is now ONE row set per language covering the last
 * `TREND_WINDOW_HOURS`, replaced wholesale on each recompute. What accumulates
 * instead is `term_snapshots` — raw hourly counts, the baseline's only input.
 *
 * Dropping `daily_terms` loses nothing recomputable: the next sample rebuilds
 * the cloud from `articles`, and a baseline in day units cannot be carried into
 * one measured over 24-hour windows anyway. It warms again over a week, exactly
 * as it did at launch (§10.3).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS daily_terms`.execute(db);

  await sql`
    CREATE TABLE trending_terms (
      language     text        NOT NULL,
      term         text        NOT NULL,
      is_bigram    boolean     NOT NULL,
      df_articles  int         NOT NULL,
      df_domains   int         NOT NULL,
      weighted_df  real        NOT NULL,
      score        real        NOT NULL,
      window_start timestamptz NOT NULL,
      window_end   timestamptz NOT NULL,
      PRIMARY KEY (language, term)
    )
  `.execute(db);
  await sql`
    CREATE INDEX trending_terms_top_idx ON trending_terms (language, score DESC)
  `.execute(db);

  await sql`
    CREATE TABLE term_snapshots (
      bucket_hour timestamptz NOT NULL,
      language    text        NOT NULL,
      term        text        NOT NULL,
      df_articles int         NOT NULL,
      PRIMARY KEY (bucket_hour, language, term)
    )
  `.execute(db);
  await sql`
    CREATE INDEX term_snapshots_prune_idx ON term_snapshots (bucket_hour)
  `.execute(db);

  // The baseline's stamp is an instant now, not a date: it is refreshed on
  // every sample, and "which day did this happen on" is the question ADR-0008
  // stopped asking. Truncate rather than convert — day-unit means do not
  // describe 24-hour windows, and the next refresh rebuilds this table whole.
  await sql`TRUNCATE term_baseline`.execute(db);
  await sql`ALTER TABLE term_baseline DROP COLUMN updated_on`.execute(db);
  await sql`
    ALTER TABLE term_baseline ADD COLUMN updated_at timestamptz NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS term_snapshots`.execute(db);
  await sql`DROP TABLE IF EXISTS trending_terms`.execute(db);
  await sql`TRUNCATE term_baseline`.execute(db);
  await sql`ALTER TABLE term_baseline DROP COLUMN updated_at`.execute(db);
  await sql`ALTER TABLE term_baseline ADD COLUMN updated_on date NOT NULL`.execute(db);
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
}
