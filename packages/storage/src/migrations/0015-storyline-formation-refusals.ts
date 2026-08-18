import { sql, type Kysely } from "kysely";

/**
 * Formations a coherence verdict refused: "these two groups are not one story"
 * (ADR-0011's amendment; docs/STORYLINE-LINKING.md, "The verdict, measured").
 *
 * The linker's token evidence cannot tell coverage of one event from two
 * articles sharing a word — measured over the archive's hand-judged storylines,
 * thirty-one settings across five families all destroy more real arcs than they
 * prevent piles. A model asked outright separates them at the two-group moment,
 * and this table is what stops it being asked the same question every night.
 *
 * Without it the loop is: the nightly late-candidate sweep re-offers a group
 * still sitting in its own provisional storyline, the group re-qualifies for the
 * same partner, the gate spends a model call, refuses again, and nothing has
 * changed except the bill. The dev key's ceiling is 500 requests per day.
 *
 * ## Why the key is a GROUP pair
 *
 * The refused thing is a pair of groups, not a pair of UUIDs. A provisional
 * storyline-of-one is an identity a group happens to be wearing: it can be
 * merged away and become an alias, and then a refusal keyed on it would name
 * nothing while the groups it was about are still there. Groups are what the
 * verdict actually read.
 *
 * Canonically ordered (lo < hi), for the reason `storyline_bridges` is: the
 * refusal is symmetric, and whichever group happens to arrive second must not
 * be able to ask again from the other side.
 *
 * ## What it does NOT bar
 *
 * Only the FORMATION. A refusal says two singletons are not a story between
 * them; it does not say that one of them may never join the other's arc once
 * that arc is real and several groups wide. That is a different question, the
 * gate is measurably bad at it (43% false refusals on mature arcs), and the
 * linker only consults this table where it is about to form.
 *
 * No foreign key to `articles(group_id)`: a group id is not a table's primary
 * key here — it is the identity a group of articles shares — and retention may
 * remove the last article of a group. A refusal about a group that no longer
 * exists is inert rather than a constraint violation.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE storyline_formation_refusals (
      group_lo bigint NOT NULL,
      group_hi bigint NOT NULL,
      refused_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_lo, group_hi),
      CONSTRAINT storyline_formation_refusals_ordered CHECK (group_lo < group_hi)
    )
  `.execute(db);

  // The read is "everything this group has been refused against", and the
  // arriving group may be on either side of the pair. The primary key serves
  // `group_lo`; this serves `group_hi`.
  await sql`
    CREATE INDEX storyline_formation_refusals_hi_idx
      ON storyline_formation_refusals (group_hi)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS storyline_formation_refusals`.execute(db);
}
