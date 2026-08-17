import { sql, type Kysely } from "kysely";

/**
 * The cloud stops being made of terms (ADR-0013), so the three tables that
 * existed to compute one go:
 *
 *  - `trending_terms` — the computed cloud, one row set per language. The cloud
 *    is now a query over `storylines`, so there is nothing left to store: a
 *    storyline's label, membership and day slots are already maintained by the
 *    linker at write time.
 *  - `term_snapshots` — the hourly RAW history, and the only derived table here
 *    that grew without bound (§7.5's one real prune goes with it).
 *  - `term_baseline` — the trailing per-term mean that suppressed perennial
 *    news vocabulary. A storyline needs no suppressor: "Donald Trump" is not a
 *    storyline, "Trump Iran War" is, and the linker's own bars decide that
 *    before the cloud ever sees it (ADR-0011).
 *
 * Nothing irreplaceable leaves. All three were derived from `articles`, which
 * ADR-0001 keeps, so no ADR-0001 exemption is needed. What is genuinely lost is
 * the accumulated baseline itself — seven days of hourly observations that took
 * a week of traffic to earn — and `down` cannot bring it back. It restores the
 * schema empty, the state the tables were in at launch, and a week of samples
 * refills them. Recorded plainly because a `down` that returns less than it
 * took is exactly what hand-written migrations exist to make visible
 * (ADR-0003).
 *
 * Added in their place: one index. The old cloud was computed by the sampler
 * and merely READ on the request path; the new one is aggregated on the request
 * path itself, behind the same 15-minute Redis entry. `articles_timeline_idx`
 * can serve the window scan, but every cloud read is language-scoped, so the
 * language belongs in front of the range.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS trending_terms`.execute(db);
  await sql`DROP TABLE IF EXISTS term_snapshots`.execute(db);
  await sql`DROP TABLE IF EXISTS term_baseline`.execute(db);

  await sql`
    CREATE INDEX articles_language_window_idx ON articles (language, published DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS articles_language_window_idx`.execute(db);

  // The schema as 0002 and 0005 left it — empty. The counts are gone.
  await sql`
    CREATE TABLE term_baseline (
      language   text        NOT NULL,
      term       text        NOT NULL,
      mean_df    real        NOT NULL,
      updated_at timestamptz NOT NULL,
      PRIMARY KEY (language, term)
    )
  `.execute(db);

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
}
