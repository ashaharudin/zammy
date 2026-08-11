import { sql, type Kysely } from "kysely";

/**
 * Stamp `articles.title_tokens` with the tokenizer that produced it
 * (ARCHITECTURE 14.3, ADR-0005).
 *
 * `title_tokens` is a materialized derivation of a rule we keep changing — the
 * same hazard ADR-0002 named for URL canonicalization, "a rule we keep
 * widening". Plural folding shipped and every row written before it kept
 * storing `chiefs` while new rows store `chief`, so a newcomer compared
 * against stale vocabulary and scored lower than the rule intends. Measured on
 * live data: a pair that scores 0.538 today scored 0.429 against the stored
 * tokens, straddling the 0.50 bar.
 *
 * Nothing noticed. The version is what makes it noticeable: rows below the
 * current tokenizer are findable, countable, and re-derivable by the regroup
 * command, instead of quietly degrading every comparison they take part in.
 *
 * Existing rows are version 0 by definition — including the ones with empty
 * tokens from before grouping existed, which the backfill can now populate.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE articles ADD COLUMN tokens_version smallint NOT NULL DEFAULT 0
  `.execute(db);
  // Partial index over exactly what the backfill scans: rows behind the
  // current tokenizer. It shrinks to nothing once a backfill completes, which
  // is the point — the healthy state costs nothing to check.
  await sql`
    CREATE INDEX articles_stale_tokens_idx ON articles (published DESC) WHERE tokens_version = 0
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS articles_stale_tokens_idx`.execute(db);
  await sql`ALTER TABLE articles DROP COLUMN IF EXISTS tokens_version`.execute(db);
}
