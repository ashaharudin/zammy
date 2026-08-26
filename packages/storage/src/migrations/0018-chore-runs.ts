import { sql, type Kysely } from "kysely";

/**
 * `chore_runs`: a durable record that a nightly pass ran, what it did, and what
 * it cost (VERCEL-ALL-IN-SCOPE §3.3, §7).
 *
 * ## Why a table and not a log line
 *
 * Every pass already logs a structured summary, and on every deployment target
 * this project has had, that was enough. It stops being enough on Vercel Hobby
 * for two compounding reasons: **the route always answers 202** — the work runs
 * in `waitUntil` after the response, so the scheduler cannot see a failure and
 * has nothing to report — and **logs are retained for one hour**. A pass that
 * failed at 03:00 leaves no trace by 04:01. "Did last night's chores run?" is
 * then unanswerable by construction, and it is the only question an operator
 * actually asks about this half of the system.
 *
 * ADR-0011's percolation alarm has the same shape and the same problem: a
 * single night's graph shape says nothing, and `runStorylineGraphChore`'s own
 * comment names this table as the home the series wants
 * (VERCEL-PHASE-0-FINDINGS §2.7).
 *
 * ## Why the row is written at the START and updated at the end
 *
 * §3.3 specified one write "at pass end". That is one write cheaper and it
 * cannot record the failure this route is most exposed to. `maxDuration` is 300 s
 * on Hobby and the label pass is the pass that approaches it; when the platform
 * kills the function mid-pass there is no `finally` to run, no log line past the
 * kill, and — with an end-only write — **no row at all**. The night would be
 * indistinguishable from one where nothing was ever scheduled, which is exactly
 * the confusion the table exists to prevent.
 *
 * So: `INSERT` before the work, `UPDATE` after it. `finished_at IS NULL` on a row
 * older than the ceiling is then a positive statement — *this pass started and
 * did not come back* — rather than an absence of evidence. The cost is one extra
 * round trip per pass per night.
 *
 * It also makes the row a **guaranteed nightly write through the pooler**, which
 * §3.3 wants for its own reasons, on nights the pass fails as well as nights it
 * succeeds. (It is still not the pause guard: that is a separate route on a
 * separate schedule, deliberately, so "the database stays awake" does not share
 * a failure mode with the most complex nightly job.)
 *
 * ## Why `outcome` has three values and not two
 *
 * `skipped` is a first-class outcome because the advisory lock makes it a normal
 * one: two schedulers pointed at one database is a configuration mistake nothing
 * else would catch, and the second run skipping is the mechanism working. A
 * skipped run recorded as a failure would train an operator to ignore failures;
 * one recorded as a success would hide a run that never finishes and therefore
 * makes every subsequent night skip.
 *
 * ## Why `model_calls` is a column when it is also in `report`
 *
 * It is the one number in the report that is a *cost* and that gets summed
 * ACROSS rows — "how much Gemini did last week spend?" — and `jsonb` is where
 * values go to not be aggregated. Everything else in the report is read one
 * night at a time. Null means the pass makes no model calls at all, which is
 * every pass except the label one; zero means it could have and did not.
 */

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE chore_runs (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- The addressable pass name, exactly as the route's query parameter and
      -- the CLI's argument spell it. Text and not an enum: a new pass must not
      -- need a migration, and a pass that is renamed must not silently make the
      -- old rows unreadable.
      pass        text        NOT NULL,
      -- 'route' or 'cli'. Both entrypoints write here, so the table is the whole
      -- answer to "did it run" rather than the Vercel half of it — and a night
      -- somebody ran by hand from a laptop is visible as such.
      source      text        NOT NULL,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      outcome     text,
      -- The pass's own report, summarized: unbounded members (the retention
      -- report's idle-topic fingerprints) are replaced by their counts before
      -- they get here, because this is a record of the night and not a second
      -- copy of the corpus.
      report      jsonb,
      -- The failure message, for an outcome of 'failed'. The stack goes to the
      -- log; this is the part that has to outlive the hour.
      error       text,
      -- Model calls this run spent. See the header.
      model_calls integer,
      CONSTRAINT chore_runs_outcome_known
        CHECK (outcome IS NULL OR outcome IN ('ok', 'failed', 'skipped')),
      -- The two halves of "finished" move together or the row lies about which
      -- state it is in. An unfinished row is the killed-mid-pass case above and
      -- must stay distinguishable from every finished one.
      CONSTRAINT chore_runs_finished_together
        CHECK ((finished_at IS NULL) = (outcome IS NULL))
    )
  `.execute(db);

  // The only read anybody makes: "the most recent run(s) of this pass".
  // Descending, because nobody asks for the oldest.
  await sql`
    CREATE INDEX chore_runs_pass_started_idx ON chore_runs (pass, started_at DESC)
  `.execute(db);

  // And the unqualified form of the same question — "what ran last night" across
  // every pass — which the composite index above cannot serve leading with
  // `pass`.
  await sql`
    CREATE INDEX chore_runs_started_idx ON chore_runs (started_at DESC)
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS chore_runs`.execute(db);
}
