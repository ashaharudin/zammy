import { sql, type Kysely } from "kysely";

/**
 * Storylines v2 (ADR-0011): a storyline is a persistent arc of one event, paged
 * as storyline-days. Three tables, replacing the denormalized `storyline_id` /
 * `storyline_published` columns 0006 put on `articles` — which stay, untouched
 * and still authoritative, until the cutover migration drops them. This
 * migration is purely additive on purpose: the old read and write paths must
 * keep working while the new linker, backfill and read path are built behind a
 * flag.
 *
 * Why a real table now, when 0006 argued so hard for columns: the old storyline
 * was day-bounded, so its identity could be a group id and its position could be
 * denormalized onto every member. Neither survives unboundedness. A storyline
 * that outlives any one day needs an identity that is not a group's (UUID, never
 * a label — labels are non-unique presentation), membership that is genuinely
 * many-to-many (a group may belong to several storylines), and a position that
 * is per-day rather than per-storyline. `storyline_days` is what keeps ADR-0002's
 * spirit under all that: position is still computed at write time, and step one
 * of the timeline read is still a pure index scan over a keyset — it is just a
 * scan of this table instead of `articles`.
 *
 *  - `storylines`       identity, label, profile tokens, status, alias pointer.
 *  - `storyline_groups` the join. Group-level, so an article's storylines are
 *                       its group's — the group layer is untouched by ADR-0011.
 *  - `storyline_days`   one row per storyline per day it has coverage: the
 *                       keyset index, maintained at write time exactly as
 *                       `storyline_published` was.
 *
 * No foreign key on `group_id`, exactly as 0003 and 0006 argued: group identity
 * is soft state that must degrade, never block a delete. The storyline-side keys
 * DO cascade — a storyline's joins and day slots have no meaning without it.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE storylines (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      label          text,
      label_at       timestamptz,
      profile_tokens text[] NOT NULL DEFAULT '{}',
      status         text NOT NULL DEFAULT 'provisional',
      merged_into    uuid REFERENCES storylines(id) ON DELETE SET NULL,
      created_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT storylines_status_check
        CHECK (status IN ('provisional', 'active', 'dormant')),
      -- An alias is a pointer, not a storyline; pointing at itself would make
      -- alias resolution non-terminating.
      CONSTRAINT storylines_alias_not_self CHECK (merged_into IS DISTINCT FROM id)
    )
  `.execute(db);

  // Candidate retrieval (ADR-0011's Linking section): a GIN overlap between the
  // arriving group's story_tokens and profile_tokens — one index scan over a
  // small table, replacing the whole-day-in-memory read the day bound forced.
  // Partial, because an alias must never be retrieved as a candidate: it has no
  // members of its own and attaching to it would strand the group.
  await sql`
    CREATE INDEX storylines_profile_tokens_idx
      ON storylines USING gin (profile_tokens)
      WHERE merged_into IS NULL
  `.execute(db);
  // Alias flattening on merge: "every alias that pointed at the loser now points
  // at the winner", so chains stay one hop in the common case.
  await sql`
    CREATE INDEX storylines_merged_into_idx ON storylines (merged_into)
      WHERE merged_into IS NOT NULL
  `.execute(db);

  await sql`
    CREATE TABLE storyline_groups (
      storyline_id uuid   NOT NULL REFERENCES storylines(id) ON DELETE CASCADE,
      group_id     bigint NOT NULL,
      attached_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (storyline_id, group_id)
    )
  `.execute(db);
  // The other direction: which storylines is this group in. Needed by the read
  // path (a slot's membership) and by merge, and it is the index that makes
  // "a group in two storylines" cheap rather than a scan.
  await sql`
    CREATE INDEX storyline_groups_group_idx ON storyline_groups (group_id)
  `.execute(db);

  // `day_key` is text, not date, and holds the YYYY-MM-DD the API layer already
  // speaks (`zonedDayKey`, §10.1): the day is an APP_TIMEZONE calendar day, and a
  // `date` column would round-trip through the pg driver's local-timezone Date
  // parsing and come back meaning a different day than the one written. The day
  // key is a label for a bucket, never arithmetic.
  await sql`
    CREATE TABLE storyline_days (
      storyline_id       uuid   NOT NULL REFERENCES storylines(id) ON DELETE CASCADE,
      day_key            text   NOT NULL,
      day_slot_published timestamptz NOT NULL,
      lead_article_id    bigint NOT NULL,
      PRIMARY KEY (storyline_id, day_key)
    )
  `.execute(db);
  // The keyset axis the timeline pages over (§7.3, ADR-0011's timeline section).
  // No slot spans days by construction, so "unbounded in time" costs the reader
  // nothing: a ten-day storyline is ten rows here and appears ten times as the
  // reader scrolls back.
  await sql`
    CREATE INDEX storyline_days_timeline_idx
      ON storyline_days (day_slot_published DESC, storyline_id DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS storyline_days`.execute(db);
  await sql`DROP TABLE IF EXISTS storyline_groups`.execute(db);
  await sql`DROP TABLE IF EXISTS storylines`.execute(db);
}
