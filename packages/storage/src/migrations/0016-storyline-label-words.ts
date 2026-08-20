import { sql, type Kysely } from "kysely";

/**
 * The label side of storyline surfacing: a GIN index over a label's WORDS, so
 * the search that reads both of a storyline's vocabularies keeps costing one
 * index scan per keyword (`findSurfacedStorylines`).
 *
 * An expression index and not a column, because the words are a pure function
 * of the label — a column would need every label write to remember it and a
 * backfill for the ones already written, both to store what `lower` and
 * `regexp_split_to_array` (immutable, hence indexable) derive on demand.
 *
 * The expression must be spelled EXACTLY as the read spells it or the planner
 * will not match it. Measured on the dev archive's 24,398 storylines: the
 * matching half of the read went from a 15ms sequential scan to a 0.5ms
 * BitmapOr across this index and `storylines_profile_tokens_idx`, which is the
 * shape the planner has to reach for — a keyword may be satisfied by either
 * vocabulary, so neither index alone can answer the predicate.
 *
 * Partial on the same terms as the profile index, plus the label: an alias has
 * no vocabulary of its own, and an unlabelled storyline is not offered at all
 * (a surfacing pill is a name plus a size). Both conditions appear verbatim in
 * the read's WHERE clause, which is what lets the planner use a partial index.
 *
 * Splitting on runs of non-alphanumerics rather than tokenizing is deliberate,
 * and documented where the read spells it: it takes "Dillard's" apart into a
 * word a reader would type, without this layer learning the tokenizer's
 * possessive rule.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE INDEX storylines_label_words_idx
      ON storylines USING gin (regexp_split_to_array(lower(label), '[^[:alnum:]]+'))
      WHERE merged_into IS NULL AND label IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS storylines_label_words_idx`.execute(db);
}
