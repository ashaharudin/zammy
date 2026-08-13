import { sql, type Kysely } from "kysely";

/**
 * Storylines (ARCHITECTURE 14.3 amendment, ADR-0009): the loose layer above
 * groups. A group is one story syndicated; a STORYLINE is a day's coverage of
 * that story — the retrospective, the successor speculation, the fact-check —
 * clustered hub-and-spoke around the day's most-syndicated group. The timeline
 * pages over storylines now, so the whole of a day's coverage of one story is
 * one slot.
 *
 * Same shape as 0003, and for the same reasons:
 *
 *  - **columns on `articles`, no new table.** A storyline is the set of rows
 *    sharing a `storyline_id`; its identity and position are denormalized onto
 *    the members so the timeline read stays one index scan with no join.
 *  - `storyline_id`         the HUB group's id. Equals `group_id` for a group
 *                           that leads its own storyline, which is what every
 *                           group starts as.
 *  - `storyline_published`  MIN(published) over the storyline — the new keyset
 *                           axis, replacing `group_published` for paging only.
 *  - `story_tokens`         title+description tokens, the storyline layer's
 *                           matching surface. Versioned by the SAME
 *                           `tokens_version` as `title_tokens`: both are
 *                           derivations of one tokenizer generation, and two
 *                           staleness clocks for one regroup pass would drift.
 *
 * No foreign key on `storyline_id`, exactly as 0003 argued for `group_id`: it
 * is soft state that must degrade, never block a delete.
 *
 * Existing rows are backfilled as their own group's storyline. Like grouping
 * before it (0003), the layer is forward-looking until an operator runs the
 * regroup command over a chosen window — clustering the archive moves rows
 * under live cursors, and how much of that to accept is a person's decision
 * (ADR-0005's posture, unchanged).
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE articles
      ADD COLUMN storyline_id        bigint,
      ADD COLUMN storyline_published timestamptz,
      ADD COLUMN story_tokens        text[] NOT NULL DEFAULT '{}'
  `.execute(db);

  await sql`
    UPDATE articles SET storyline_id = group_id, storyline_published = group_published
  `.execute(db);

  // BEFORE INSERT, like articles_seed_own_group_trg, and alphabetically AFTER
  // it — triggers on one event fire in name order, so NEW.group_id and
  // NEW.group_published are already seeded when this reads them. A row
  // inserted with a null storyline_id would sort first under ORDER BY
  // storyline_published DESC and corrupt paging, so membership is structural,
  // not a caller convention.
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

  // The keyset axis the timeline pages over now (§7.3); articles_group_timeline_idx
  // stays for the storyline pass's per-day group reads.
  await sql`
    CREATE INDEX articles_storyline_timeline_idx
      ON articles (storyline_published DESC, storyline_id DESC)
  `.execute(db);
  // Members of a storyline: the read's second step, and position recomputes.
  await sql`CREATE INDEX articles_storyline_idx ON articles (storyline_id)`.execute(db);
  // Candidate narrowing for storyline attachment, GROUPING's GIN twin: the
  // anchor-token overlap that turns "compare against the day" into "compare
  // against a handful".
  await sql`
    CREATE INDEX articles_story_tokens_idx ON articles USING gin (story_tokens)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS articles_seed_own_storyline_trg ON articles`.execute(db);
  await sql`DROP FUNCTION IF EXISTS articles_seed_own_storyline()`.execute(db);
  await sql`
    ALTER TABLE articles
      DROP COLUMN IF EXISTS storyline_id,
      DROP COLUMN IF EXISTS storyline_published,
      DROP COLUMN IF EXISTS story_tokens
  `.execute(db);
}
