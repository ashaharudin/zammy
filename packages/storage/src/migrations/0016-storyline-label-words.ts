import { sql, type Kysely } from "kysely";

/**
 * The label side of storyline surfacing: a storyline's label as WORDS, so the
 * search that reads both of its vocabularies keeps costing one index scan per
 * keyword (`findSurfacedStorylines`).
 *
 * A column and not an expression index, because the fold is not expressible in
 * SQL and must not be re-expressed there. Label words are folded by
 * `normalizeLabel` — `trimWordPunctuation` and then `singular`, the same two
 * steps in the same order the corpus ran on its way into `story_tokens` — and
 * that is the whole point: `profile_tokens` and `label_words` reach the SAME
 * SPELLING for the same word, so surfacing compares one folded keyword against
 * both with `@>` and needs no inverse fold to bridge them.
 *
 * A `regexp_split_to_array(lower(label), ...)` expression index was the obvious
 * alternative and is the wrong one. It buys the derivation for free — no write
 * to remember it, no backfill — and pays for it with a second definition of
 * "the label's words" living in another language, which is the duplicate this
 * codebase refuses for tokenizers and refuses here for the same reason: the two
 * spellings drift and the drift is silent. It also splits on the apostrophe
 * rather than folding the possessive, so it never learns the `dillard'` lesson
 * `trimWordPunctuation` already paid for, and its `[:alnum:]` class is
 * collation-dependent where the fold is not.
 *
 * So the write path owns it: `setStorylineLabel` is the one writer of a non-null
 * label, and it now writes the words beside it. The column carries `'{}'` until
 * then, which is what makes this migration safe to run ahead of the API — an
 * un-backfilled row simply does not match on the label side and surfacing
 * degrades to the profile-only behaviour it had before. `backfill:label-words`
 * fills them in; it is pure local computation, no upstream call and no model.
 *
 * Partial on `merged_into IS NULL`, exactly as `storylines_profile_tokens_idx`
 * is: an alias is a pointer with no vocabulary of its own.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE storylines
      ADD COLUMN label_words text[] NOT NULL DEFAULT '{}'
  `.execute(db);

  await sql`
    CREATE INDEX storylines_label_words_idx
      ON storylines USING gin (label_words)
      WHERE merged_into IS NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS storylines_label_words_idx`.execute(db);
  await sql`ALTER TABLE storylines DROP COLUMN IF EXISTS label_words`.execute(db);
}
