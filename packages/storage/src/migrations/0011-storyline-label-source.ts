import { sql, type Kysely } from "kysely";

/**
 * What produced a storyline's label (ADR-0011, "Labels"): the model id, the
 * string `bigram` for the extractor fallback, or null when nothing could name
 * it.
 *
 * Added because a relabel campaign could not resume. `--relabel` exists to say
 * "the model config changed, re-name everything the fallback named" — and with
 * no record of what named what, that question has no answer, so the flag had to
 * mean "re-name EVERYTHING, every run". A campaign of 2,782 storylines at ~7s
 * per call is five and a half hours; one that starts over from the top after an
 * interruption spends the whole bill again and may never finish.
 *
 * The model ID rather than a `'model' | 'bigram'` enum, because the question an
 * operator actually asks is "is this label from the model I have configured
 * NOW" — upgrading from one model to a better one is the same operation as
 * upgrading from the fallback, and an enum cannot tell those apart.
 *
 * Null means "unknown provenance": labelled before this column existed, or
 * never labelled. A relabel treats unknown as needing work, which is one wasted
 * call per pre-existing label and never a missed one.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE storylines ADD COLUMN label_source text`.execute(db);
  // The relabel pass's skip predicate: "everything whose source is not the
  // configured model". Partial, because unlabelled and alias rows are never
  // its subject.
  await sql`
    CREATE INDEX storylines_label_source_idx ON storylines (label_source)
      WHERE merged_into IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS storylines_label_source_idx`.execute(db);
  await sql`ALTER TABLE storylines DROP COLUMN IF EXISTS label_source`.execute(db);
}
