import { sql, type Kysely } from "kysely";

/**
 * `storylines.link_dirty_at`: the "changed since" marker the nightly
 * late-candidate sweep filters on (docs/ARCHITECTURE.md §9.1;
 * docs/RESEARCH-BIRTH-TRIGGERED-LATE-CANDIDATES.md §9).
 *
 * The sweep offers every group in the trailing DF window to the linker every
 * night — 12,338 groups at ~41ms is ~506s, and most of it buys nothing because
 * most groups' candidate sets are exactly what they were last night. What the
 * filter needs is a way to ask "which arcs changed?", and none of the columns
 * already here can answer it.
 *
 * ## Why the marker lives HERE, on the row that changed
 *
 * Three homes were considered and two rejected.
 *
 * **Not `storyline_groups.attached_at`.** It looks like the answer and is not:
 * `mergeStorylines` deliberately PRESERVES the loser's `attached_at` when it
 * re-points membership onto the winner — "when a group joined the story is a
 * fact about the group, not about which of two UUIDs won" — so the winner of a
 * merge, whose profile was just re-derived over both memberships, never appears
 * in `attached_at > $lastRun`. The column is right about what it means and
 * useless for this question.
 *
 * **Not a `chore_runs` row.** A single global "when did the sweep last run"
 * timestamp is the wrong SHAPE, before it is a question of which table it lives
 * in. It is not crash-safe — a run that dies half way through marks the whole
 * night done — it cannot survive a missed night without a lookback window
 * somebody has to keep in step with the scheduler, and it assumes a cadence the
 * app cannot see (the schedule lives outside this process entirely; `chores.ts`
 * says so). A per-row marker has none of those problems: rows the sweep did not
 * reach are still marked, so a crashed or skipped run costs latency and nothing
 * else.
 *
 * **A nullable timestamp on `storylines`, cleared by the pass that consumed
 * it.** Null means "the sweep has carried this arc's current derivations
 * forward"; non-null means "something the linker reads about this arc changed and
 * nothing has re-offered against it yet". It is a durable work queue keyed on the
 * thing that changed, and the timestamp rather than a boolean is what makes the
 * clear safe: the pass clears only markers no NEWER than the one it read, so a
 * write landing while the pass runs is not swallowed by it.
 *
 * ## Why the column starts NULL
 *
 * Backfilling `now()` would mark all 26,010 existing rows dirty and make the
 * first filtered night strictly more expensive than the unfiltered one it
 * replaces. Starting empty means a filtered pass finds nothing until the write
 * paths have marked something, which is exactly why
 * `STORYLINE_LATE_CANDIDATE_CHANGED_ONLY` defaults to off: deploy, let a night
 * of ordinary writes accumulate markers, then turn the filter on.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  // `timestamptz(3)`, and the precision is load-bearing rather than tidy.
  //
  // Every other timestamp here is `timestamptz` at Postgres's full microsecond
  // precision, which is right for them: they are read and rendered, never
  // compared against a value that has been through JavaScript. This one is. The
  // sweep pages on `(link_dirty_at, id)` and clears on `link_dirty_at <= $read`,
  // both against a `Date` — and a `Date` holds MILLISECONDS. At microsecond
  // precision `now()` writes a marker strictly greater than the `Date` the
  // driver hands back for it, so `(link_dirty_at, id) > ($read, $id)` matches
  // every row forever (the keyset never advances — measured, as an infinite
  // loop) and `link_dirty_at <= $read` matches none (the marker never clears).
  //
  // Rounding to milliseconds in the COLUMN makes the round trip exact whatever a
  // writer used — `new Date()` or a bare `now()` — which is the only place that
  // invariant cannot be forgotten.
  await sql`
    ALTER TABLE storylines ADD COLUMN link_dirty_at timestamptz(3)
  `.execute(db);

  // Partial, because the read is always "the dirty ones" and the dirty ones are
  // a few hundred rows against 26,010. `id` is in the index so the sweep's
  // keyset — `(link_dirty_at, id)`, since two arcs marked in the same
  // transaction share a timestamp — is an index-only scan.
  await sql`
    CREATE INDEX storylines_link_dirty_idx
      ON storylines (link_dirty_at, id)
      WHERE link_dirty_at IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS storylines_link_dirty_idx`.execute(db);
  await sql`ALTER TABLE storylines DROP COLUMN IF EXISTS link_dirty_at`.execute(db);
}
