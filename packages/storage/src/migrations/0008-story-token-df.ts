import { sql, type Kysely } from "kysely";

/**
 * The trailing corpus (ADR-0011, "Rarity is measured against a trailing
 * corpus"): document frequency of `story_tokens` over a rolling ~14-day
 * window, which is what the v2 linker means by "rare".
 *
 * `0008`, not `0007`: the storylines schema (S1 of the v2 plan) holds that
 * number and lands independently. The migrator sorts names lexicographically
 * and needs no contiguity — a gap is a merge that has not happened yet, not a
 * broken chain.
 *
 * **Two tables, not a view over `articles`.** The df of one group's ~30 tokens
 * is asked once per arriving group (~1,200/day), and answering it from
 * `articles` means unnesting a fortnight of `story_tokens` every time — the
 * GIN index answers "which articles contain this token", not "how many", so
 * there is no index-only path to a count. Aggregating on the write that
 * already touches the row makes the read two index scans over a table the size
 * of the window's vocabulary.
 *
 * **Day-bucketed, not a single running total.** The window rolls, so yesterday
 * must be able to leave it; a running total can only grow. Buckets also make
 * the aggregate rebuildable per day from `articles`, which is the only reason
 * the counters are allowed to be approximate (see `story-df.ts`).
 *
 * `day` is the APP_TIMEZONE calendar day, computed by the caller for the same
 * reason grouping's day bound is (§10.1): under UTC a Vancouver evening is
 * already tomorrow. `language` is `''` for an article that declares none —
 * a primary key cannot hold nulls, and rarity within an unknown-language
 * corpus is still the question being asked.
 *
 * `day` is `text` under a shape check rather than `date`: the pg driver hands
 * a `date` back as a JS Date in the local timezone, which is precisely the
 * confusion this key exists to avoid, and YYYY-MM-DD sorts and ranges
 * identically as text. It is a key, not a timestamp — nothing ever does date
 * arithmetic on the stored value.
 *
 * Deliberately NOT folded into `term_baseline`. That infrastructure means
 * something else: it holds the wordcloud's DISPLAY terms (unigrams and bigrams
 * off headlines, un-stemmed, filtered to what a cloud may show), sampled at
 * visit-driven hours, and its `mean_df` is a mean of 24-hour window counts —
 * "how loud is this term normally", where the linker asks "in how many of the
 * last fourteen days' articles does this stem appear". Sharing rows would
 * force one vocabulary and one clock on two questions that agree about neither;
 * ADR-0011 left the convergence open, and this is the answer.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE story_token_days (
      day      text NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      language text NOT NULL,
      token    text NOT NULL,
      df       int  NOT NULL,
      PRIMARY KEY (day, language, token)
    )
  `.execute(db);

  // The lookup is (language, token) over a day range for ~30 tokens at once —
  // token before day so `= any($tokens)` is the leading predicate and the
  // window is a range scan inside it. The primary key serves the opposite
  // shape (whole-day rebuild and prune), which is why both exist.
  await sql`
    CREATE INDEX story_token_days_lookup_idx
      ON story_token_days (language, token, day)
  `.execute(db);

  await sql`
    CREATE TABLE story_corpus_days (
      day      text NOT NULL CHECK (day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
      language text NOT NULL,
      articles int  NOT NULL,
      PRIMARY KEY (day, language)
    )
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS story_corpus_days`.execute(db);
  await sql`DROP TABLE IF EXISTS story_token_days`.execute(db);
}
