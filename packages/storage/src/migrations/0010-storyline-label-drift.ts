import { sql, type Kysely } from "kysely";

/**
 * The drift clock for storyline labels (ADR-0011, "Labels"): how many member
 * groups the storyline had when its label was generated.
 *
 * A label is regenerated at promotion, on merge, and on DRIFT — "membership
 * doubled since the label was made" — and that last trigger needs a number this
 * schema does not otherwise hold. It cannot be derived: `storyline_groups`
 * keeps each group's original `attached_at` through a merge (when a group
 * joined the story is a fact about the group, not about which UUID won), so
 * counting joins older than `label_at` counts groups that reached this
 * storyline long after the label was written.
 *
 * Nullable, and null means "labelled before this column existed, or never
 * labelled" — both of which the labeler treats as "no drift baseline", which
 * is a relabel on the next trigger rather than a wrong decision.
 *
 * Numbered 0010, not 0009: the linker session took 0009 for `storyline_bridges`
 * while this was being written. Names sort lexicographically and the runner
 * does not require contiguity, so a gap here would be harmless — but a
 * COLLISION would be two different migrations claiming one name, which is a
 * ledger that can never be reconciled across two databases.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE storylines ADD COLUMN label_group_count int`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE storylines DROP COLUMN IF EXISTS label_group_count`.execute(db);
}
