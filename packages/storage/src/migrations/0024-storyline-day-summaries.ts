import { sql, type Kysely } from "kysely";

/**
 * The historical preserve: one sentence per storyline-day, and one per populated
 * 6-hour UTC segment of it (docs/STORYLINE-SUMMARIES.md, ADR-0023).
 *
 * Every other derived table in this schema is rebuildable from `articles` —
 * `story_token_days` is pruned nightly, `storyline_days` is recomputed by
 * `refreshStorylineDerivations`, and the grouping columns are re-derived by a
 * regroup pass. **This one is not.** A summary is the output of a model call
 * over articles that will eventually be retained away, so once the articles are
 * gone the sentence is the only surviving record of what that day held. That one
 * fact is what shapes every unusual decision below.
 *
 * ## Why there is no foreign key on `storyline_id`
 *
 * `storyline_groups` and `storyline_days` both cascade from `storylines`, which
 * is right for them — a membership row or a day slot has no meaning without the
 * arc it belongs to, and both are rebuildable. A preserve that cascaded away
 * with its storyline would be a preserve that deletes itself, which is the one
 * thing it must not do. So `storyline_id` is soft state here, exactly as
 * `articles.group_id` and `articles.storyline_id` were argued in 0003 and 0006:
 * a pointer that must degrade, never a constraint that blocks or cascades.
 *
 * The consequence, stated rather than hidden: a merge leaves these rows on the
 * id they were written for. `storylines.merged_into` still resolves that id to
 * the winner, so a reader that wants the winner's whole history follows the
 * alias chain — the same hop every other holder of a storyline UUID makes. What
 * it does NOT do is rewrite history under the merge, which would make yesterday's
 * preserve say something the coverage never said.
 *
 * ## Why the row denormalizes so much
 *
 * `label`, `article_count` and `model_id` are all derivable TODAY and none of
 * them is derivable once retention takes the articles. The label additionally
 * drifts by design (ADR-0011 relabels on drift), so the label a summary was
 * generated under is not the label the storyline carries now, and reading the
 * live one back would silently re-caption the past.
 *
 * ## The three states of a row, and why NULL is one of them
 *
 *  - **no row**        no articles landed in that segment. The skip the whole
 *                      feature is specified around.
 *  - **row, summary null** the model was asked and would not answer — `attempts`
 *                      says how many times. Prose has no deterministic fallback
 *                      (a bigram sentence would be worse than silence), so this
 *                      is what a refusal looks like, and it must be
 *                      distinguishable from the case above or "skip the empty
 *                      segments" stops being a readable rule.
 *  - **row, summary set**  the sentence.
 *
 * ## `segmented`
 *
 * False on a day summarized without segments. That is not a formatting choice:
 * Google News drops the pubDate TIME beyond ~8 days and stamps 89.4% of those
 * rows at midnight US Pacific, so a backfilled day's articles nearly all fall
 * into one 6-hour bucket. Writing four segment sentences off that would be
 * inventing a shape the data does not have, so old days get the day sentence
 * only and this column says so — the difference between "that day had no
 * evening coverage" and "we could not tell when that day's coverage landed".
 *
 * ## `day_key` is UTC here, and only here
 *
 * `storyline_days.day_key` is an APP_TIMEZONE calendar day. This table's is
 * always UTC, because the segments are defined in UTC and a day whose boundaries
 * disagreed with its own quarters would be four sentences about a span the fifth
 * does not cover. `APP_TIMEZONE` defaults to UTC, so the two agree today;
 * `summaryDayKey` computes this one in UTC regardless, and config warns if
 * `APP_TIMEZONE` ever stops being UTC.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE storyline_day_summaries (
      storyline_id  uuid NOT NULL,
      day_key       text NOT NULL,
      segment       text NOT NULL,
      summary       text,
      article_count int  NOT NULL,
      label         text,
      model_id      text,
      attempts      int  NOT NULL DEFAULT 0,
      segmented     boolean NOT NULL DEFAULT true,
      generated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (storyline_id, day_key, segment),
      CONSTRAINT storyline_day_summaries_segment_check
        CHECK (segment IN ('night', 'morning', 'afternoon', 'evening', 'day')),
      -- A count is the recompute trigger (a segment that gained more than N
      -- articles inside the settling window is rewritten), so a negative one
      -- would be a comparison that never fires again.
      CONSTRAINT storyline_day_summaries_count_check CHECK (article_count >= 0)
    )
  `.execute(db);

  // The PK's leading columns already serve the pass's read ("what does this
  // storyline-day already have?"). This one serves the other direction — a day
  // across every storyline — which is what a historical read asks and what the
  // backfill reports on. Cheap: the table grows by storyline-days, not articles.
  await sql`
    CREATE INDEX storyline_day_summaries_day_idx ON storyline_day_summaries (day_key)
  `.execute(db);

  // Migration 0019's standing convention: a migration that creates a table
  // enables RLS on it, in the same `up`. `migrator.test.ts` asserts it.
  await sql`ALTER TABLE storyline_day_summaries ENABLE ROW LEVEL SECURITY`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Worth pausing over before running: unlike every other `down` in this
  // schema, what this drops cannot be rebuilt from `articles` — the model calls
  // that produced these sentences are spent, and any article retention has
  // taken since is gone. Roll this back only as part of rolling back the
  // release it shipped in, and dump the table first if the rows matter.
  await sql`DROP TABLE IF EXISTS storyline_day_summaries`.execute(db);
}
