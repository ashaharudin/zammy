import { sql, type Kysely } from "kysely";

/**
 * Article grouping (ARCHITECTURE 14.3): the same story republished at
 * different URLs across outlets keeps every row — the wordcloud's `df_domains`
 * breadth signal needs them (§10.3) — and gains a group, so the timeline shows
 * one member with the rest reachable as "related".
 *
 * Three columns on `articles`, no new table. A group is not an entity with
 * attributes of its own; it is the set of rows sharing a `group_id`, and its
 * two derived facts (identity, position) live on the members so a timeline
 * read stays one index scan with no join back (the same reasoning that
 * denormalized the display fields in §7.2).
 *
 *  - `group_id`         the SEED article's id — the immutable article later
 *                       candidates are compared against. Self for a group of
 *                       one, which is what every article starts as.
 *  - `group_published`  MIN(published) over the group: the group's position,
 *                       and the new keyset axis. Held here rather than
 *                       recomputed because §7.3's page size and `hasMore`
 *                       depend on paging being an index scan.
 *  - `title_tokens`     the headline tokens candidate lookup matches on.
 *
 * `group_id` deliberately carries **no foreign key** to `articles(id)`. It is
 * soft state: a dangling seed must degrade a group to loose members, never
 * block a delete. Retention only reports today (§7.5), but the day it deletes,
 * this must not be the thing that stops it.
 *
 * Existing rows are backfilled as groups of one and keep empty `title_tokens`,
 * so they are never candidates and never join a group. Grouping is
 * forward-looking by design: retroactively regrouping the archive would move
 * rows under live cursors for no reader's benefit.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE articles
      ADD COLUMN group_id        bigint,
      ADD COLUMN group_published timestamptz,
      ADD COLUMN title_tokens    text[] NOT NULL DEFAULT '{}'
  `.execute(db);

  await sql`UPDATE articles SET group_id = id, group_published = published`.execute(db);

  // The self-referential default cannot be a column DEFAULT (it needs the
  // identity value of the row being inserted) and must not be left to callers:
  // a row inserted with a null group_id would sort FIRST under `ORDER BY
  // group_published DESC` and corrupt paging for every reader. A BEFORE INSERT
  // trigger makes "every article is in a group" structural — true for the
  // ingest path, for tests, and for whatever writes rows next.
  await sql`
    CREATE FUNCTION articles_seed_own_group() RETURNS trigger AS $$
    BEGIN
      IF NEW.group_id IS NULL THEN NEW.group_id := NEW.id; END IF;
      IF NEW.group_published IS NULL THEN NEW.group_published := NEW.published; END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);
  await sql`
    CREATE TRIGGER articles_seed_own_group_trg
      BEFORE INSERT ON articles
      FOR EACH ROW EXECUTE FUNCTION articles_seed_own_group()
  `.execute(db);

  await sql`
    ALTER TABLE articles
      ALTER COLUMN group_id        SET NOT NULL,
      ALTER COLUMN group_published SET NOT NULL
  `.execute(db);

  // The keyset axis the timeline now pages over (§7.3). It replaces
  // (published, id) for paging only; articles_timeline_idx still serves the
  // day-corpus and retention scans over an article's own published.
  await sql`
    CREATE INDEX articles_group_timeline_idx ON articles (group_published DESC, group_id DESC)
  `.execute(db);
  // Members of a group: the read's second step, and the position recompute.
  await sql`CREATE INDEX articles_group_idx ON articles (group_id)`.execute(db);
  // Candidate narrowing at write time: same-day seeds sharing a headline
  // token. Without it, grouping one article means scanning the whole day.
  await sql`
    CREATE INDEX articles_title_tokens_idx ON articles USING gin (title_tokens)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TRIGGER IF EXISTS articles_seed_own_group_trg ON articles`.execute(db);
  await sql`DROP FUNCTION IF EXISTS articles_seed_own_group()`.execute(db);
  await sql`
    ALTER TABLE articles
      DROP COLUMN IF EXISTS group_id,
      DROP COLUMN IF EXISTS group_published,
      DROP COLUMN IF EXISTS title_tokens
  `.execute(db);
}
