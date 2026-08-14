import { sql, type Kysely } from "kysely";

/**
 * The cutover (ADR-0011's Rollout): the day-bounded storyline model is gone, so
 * the columns that carried it go with it.
 *
 * 0006 put a storyline's identity and position on every article row, and the
 * reasoning was sound for what a storyline was THEN — day-bounded, so its
 * identity could be a group id and its position could be denormalized onto its
 * members. Neither survives unboundedness: identity is a UUID in `storylines`
 * and position is per-day in `storyline_days`, both written by the linker.
 *
 * Dropped here:
 *  - `articles.storyline_id` / `articles.storyline_published`
 *  - `articles_seed_own_storyline` and its BEFORE INSERT trigger — the
 *    seed-own-identity discipline it enforced still exists, one layer up, as
 *    `createProvisionalStoryline`
 *  - `articles_storyline_timeline_idx` and `articles_storyline_idx`, which
 *    Postgres would drop with the columns anyway; named so the reversal has
 *    something to recreate
 *
 * KEPT, and deliberately: `story_tokens` and its GIN index. They are the
 * LINKER's input — the arriving group's tokens, and the surface candidate
 * retrieval overlaps against — so they outlive the model that introduced them.
 *
 * **This is not reversible in the sense that matters.** `down` restores the
 * schema and the trigger, and every existing row gets its group's identity
 * back, which is what the trigger would have written for a group of one. What
 * it cannot restore is the day CLUSTERING: which groups the old hub-and-spoke
 * pass had put together is not derivable from anything left standing. A
 * rollback therefore lands on a database where every group leads its own
 * storyline again, and `pnpm regroup` is what rebuilds the rest. Recorded here
 * because a `down` that silently returns less than it took is the failure mode
 * hand-written migrations exist to make visible (ADR-0003).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS articles_seed_own_storyline_trg ON articles`.execute(db);
  await sql`DROP FUNCTION IF EXISTS articles_seed_own_storyline()`.execute(db);

  // Indexes first and explicitly, rather than letting the column drop take
  // them: the names are the record of what existed, and `down` recreates them.
  await sql`DROP INDEX IF EXISTS articles_storyline_timeline_idx`.execute(db);
  await sql`DROP INDEX IF EXISTS articles_storyline_idx`.execute(db);

  await sql`
    ALTER TABLE articles
      DROP COLUMN IF EXISTS storyline_id,
      DROP COLUMN IF EXISTS storyline_published
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE articles
      ADD COLUMN storyline_id        bigint,
      ADD COLUMN storyline_published timestamptz
  `.execute(db);

  // Every group leads its own storyline again — the state 0006 backfilled into
  // a fresh install, and all that is recoverable. The clustering is not.
  await sql`
    UPDATE articles SET storyline_id = group_id, storyline_published = group_published
  `.execute(db);

  await sql`
    CREATE FUNCTION articles_seed_own_storyline() RETURNS trigger AS $$
    BEGIN
      IF NEW.storyline_id IS NULL THEN NEW.storyline_id := NEW.group_id; END IF;
      IF NEW.storyline_published IS NULL THEN NEW.storyline_published := NEW.group_published; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER articles_seed_own_storyline_trg
      BEFORE INSERT ON articles
      FOR EACH ROW EXECUTE FUNCTION articles_seed_own_storyline()
  `.execute(db);

  await sql`
    ALTER TABLE articles
      ALTER COLUMN storyline_id        SET NOT NULL,
      ALTER COLUMN storyline_published SET NOT NULL
  `.execute(db);

  await sql`
    CREATE INDEX articles_storyline_timeline_idx
      ON articles (storyline_published DESC, storyline_id DESC)
  `.execute(db);
  await sql`CREATE INDEX articles_storyline_idx ON articles (storyline_id)`.execute(db);
}
