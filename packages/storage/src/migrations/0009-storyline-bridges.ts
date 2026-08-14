import { sql, type Kysely } from "kysely";

/**
 * Bridge evidence (ADR-0011's Lifecycle, "Merged, never split").
 *
 * A group that qualifies for two storylines attaches to the better and records
 * a BRIDGE between them. K independent bridges — K distinct groups, K starting
 * at 2 — merge the pair. Single-bridge merging is refused: one ambiguous
 * roundup chaining three storylines together is the 1,179-group swallow
 * delivered more slowly, and the whole design errs narrow.
 *
 * That "independent" is why this is a table rather than a counter. The evidence
 * has to be attributable — two bridges from ONE group re-evaluated twice are
 * one observation, and a counter cannot tell them apart. The primary key is
 * what enforces it.
 *
 * The pair is stored canonically ordered (`storyline_lo < storyline_hi`) under
 * a check constraint, so (a,b) and (b,a) cannot both exist and the count is a
 * plain `count(*)`. Rows cascade with either side: a merged-away storyline's
 * bridges describe a pair that no longer exists.
 *
 * `group_id` carries no foreign key, exactly as 0003, 0006 and 0007 argued —
 * group identity is soft state that must degrade, never block a delete.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE storyline_bridges (
      storyline_lo uuid   NOT NULL REFERENCES storylines(id) ON DELETE CASCADE,
      storyline_hi uuid   NOT NULL REFERENCES storylines(id) ON DELETE CASCADE,
      group_id     bigint NOT NULL,
      observed_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (storyline_lo, storyline_hi, group_id),
      CONSTRAINT storyline_bridges_ordered CHECK (storyline_lo < storyline_hi)
    )
  `.execute(db);

  // Merge rewrites every bridge touching the loser, from either side.
  await sql`
    CREATE INDEX storyline_bridges_hi_idx ON storyline_bridges (storyline_hi)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS storyline_bridges`.execute(db);
}
