import { readChoreRuns, type ChoreOutcome, type ChoreRun, type Database } from "@zammy/storage";
import type { Kysely } from "kysely";
import { CHORE_PASSES, type ChorePass } from "./chore-runner.js";
import { choreSchedules, expectedFireAt } from "./chore-schedule.js";

/**
 * `chore_runs`, read back as the answer to the question it was created for.
 *
 * ## The gap this closes
 *
 * ADR-0015 accepts one-hour log retention on Hobby and names this table as the
 * compensating record: a pass that failed at 03:00 leaves no trace in the log by
 * 04:01, and the route answers 202 before the pass starts, so the scheduler
 * never sees a failure either. `docs/chores.md` puts it plainly — "did last
 * night's chores run?" is unanswerable by construction without this table.
 *
 * And until this module, the table had exactly ONE production reader:
 * `chores-command.ts`'s `status`, which needs a shell and a `DATABASE_URL`. The
 * Vercel deployment has neither. `/readyz` reported Postgres, Redis and upstream
 * quota and said nothing at all about whether last night ran. So the durable
 * record existed and the deployment it exists FOR could not read it.
 *
 * ## What it answers, and what it refuses to
 *
 * Three questions, and they are different questions:
 *
 *   - **the last run per pass.** The row, not a judgement: source, timestamps,
 *     outcome, model calls, the error message if it failed.
 *   - **overdue.** The pass has a schedule, its most recent firing is more than
 *     `graceMs` in the past, and no run has STARTED since that firing. Started,
 *     not finished — the row is opened before the pass, so a run in flight has
 *     already discharged its schedule.
 *   - **stalled.** The newest row of that pass has `finished_at IS NULL` and
 *     started more than `maxDurationMs` ago. That is the shape a function killed
 *     at Vercel's ceiling leaves: no `finally` runs, so nothing closes the row.
 *
 * `stalled` reads the NEWEST row only, and that is deliberate. An unfinished row
 * from a week ago is a scar, not a stuck process, and a predicate that kept
 * reporting it would have `/readyz` permanently red for a night that has since
 * been re-run successfully. The self-clearing version is the useful one.
 *
 * The one shape neither predicate catches is a run that genuinely never returns
 * while its session survives: the unfinished row stops being the newest as soon
 * as the next night's run records `skipped` against a lock it still holds, and
 * `skipped` counts as a run. That state is visible in the listing rather than in
 * a boolean — a pass whose recent rows are all `skipped` behind one unfinished
 * one is exactly it, which is what `runChorePass`'s own skip warning says too.
 *
 * ## Where "overdue" gets the schedule from
 *
 * `chore-schedule.ts`, which mirrors `deploy/vercel/supabase-cron.sql` under a
 * test that fails when the two drift. Nothing about a schedule is written down
 * here, on purpose: this module is arithmetic over rows and a clock, which is
 * why `choreStatusFrom` is a pure function and its tests need no Postgres.
 */

/**
 * How late a firing may be before the missing row means something.
 *
 * The row is opened BEFORE the pass runs, so this bound has nothing to do with
 * how long a pass takes — it covers only the distance between pg_cron firing and
 * `startChoreRun` returning: a pg_net request with a 15 s timeout, a cold Node
 * boot, TLS, and config parsing. Fifteen minutes is far past all of that and
 * still well inside the hour between one job and the next, so a genuinely missed
 * firing is reported the same night rather than the next morning.
 */
export const CHORE_STATUS_GRACE_MS = 15 * 60_000;

/**
 * The platform ceiling a run cannot outlive — `vercel.json`'s `maxDuration` for
 * `api/chores.ts`, in milliseconds.
 *
 * Mirrored here rather than imported because `vercel.json` sits outside this
 * app's `tsconfig` rootDir and must not become a build input of the function
 * bundle. `chore-schedule.test.ts` reads the real file and fails if the two
 * disagree, the same treatment the cron table gets.
 *
 * A CLI run has no such ceiling, so a `cli` row unfinished past this is a
 * killed terminal rather than a killed function. Both are the same fact for an
 * operator — nothing closed the row — so the predicate does not distinguish
 * them.
 */
export const CHORE_MAX_DURATION_MS = 300_000;

/**
 * How many rows the status reads.
 *
 * Enough for a dozen nights of all nine passes, which is what makes "the last
 * run of `label-merge`" answerable at all — the six on-demand passes only appear
 * when somebody ran one. A pass with no row inside this window reads as `last:
 * null`, which means "not recently" rather than "never": the distinction is
 * `pnpm chores status --pass=<name> --limit=200`, and no predicate here depends
 * on it, because a pass with no schedule can never be overdue.
 */
export const CHORE_STATUS_LIMIT = 60;

/** One `chore_runs` row, minus the report — the digest, not the archive. */
export interface ChoreLastRun {
  runId: string;
  /** `route` or `cli`. Which half of the system ran it. */
  source: string;
  startedAt: Date;
  /** Null on a run that never came back. See `stalled`. */
  finishedAt: Date | null;
  outcome: ChoreOutcome | null;
  modelCalls: number | null;
  error: string | null;
}

export interface ChorePassStatus {
  pass: ChorePass;
  /** Every cron expression this pass is scheduled at, UTC. Empty is on-demand. */
  schedules: readonly string[];
  last: ChoreLastRun | null;
  /** The firing this pass most recently owed a row for. Null when unscheduled. */
  expectedAt: Date | null;
  overdue: boolean;
  stalled: boolean;
}

export interface ChoreStatus {
  checkedAt: Date;
  /** Every pass in `CHORE_PASSES` order, scheduled or not. */
  passes: readonly ChorePassStatus[];
  overdue: readonly ChorePass[];
  stalled: readonly ChorePass[];
  /** Nothing overdue and nothing stalled. */
  ok: boolean;
}

export interface ChoreStatusOptions {
  now: Date;
  graceMs?: number;
  maxDurationMs?: number;
}

/**
 * The status, from rows and a clock and nothing else.
 *
 * Pure, and that is the whole reason it is separate from the query below:
 * "overdue", "stalled" and "the last run per pass" are arithmetic, and
 * arithmetic asserted against a real Postgres is arithmetic asserted slowly and
 * at three cases instead of thirty.
 *
 * Row order is not assumed. `readChoreRuns` returns newest-first and this picks
 * the maximum `started_at` anyway, because a predicate that silently depended on
 * a caller's `ORDER BY` is a predicate that breaks when somebody pages.
 */
export function choreStatusFrom(
  runs: readonly ChoreRun[],
  options: ChoreStatusOptions,
): ChoreStatus {
  const { now } = options;
  const graceMs = options.graceMs ?? CHORE_STATUS_GRACE_MS;
  const maxDurationMs = options.maxDurationMs ?? CHORE_MAX_DURATION_MS;

  const passes = CHORE_PASSES.map((pass): ChorePassStatus => {
    const newest = runs
      .filter((run) => run.pass === pass)
      .reduce<ChoreRun | null>(
        (best, run) => (best === null || run.startedAt > best.startedAt ? run : best),
        null,
      );
    const schedules = choreSchedules(pass);
    const expectedAt = expectedFireAt(pass, now);

    return {
      pass,
      schedules,
      last: newest === null ? null : lastRunOf(newest),
      expectedAt,
      overdue:
        expectedAt !== null &&
        now.getTime() - expectedAt.getTime() >= graceMs &&
        (newest === null || newest.startedAt < expectedAt),
      stalled:
        newest !== null &&
        newest.finishedAt === null &&
        now.getTime() - newest.startedAt.getTime() > maxDurationMs,
    };
  });

  const overdue = passes.filter((entry) => entry.overdue).map((entry) => entry.pass);
  const stalled = passes.filter((entry) => entry.stalled).map((entry) => entry.pass);
  return {
    checkedAt: now,
    passes,
    overdue,
    stalled,
    ok: overdue.length === 0 && stalled.length === 0,
  };
}

function lastRunOf(run: ChoreRun): ChoreLastRun {
  return {
    runId: run.id,
    source: run.source,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    modelCalls: run.modelCalls,
    error: run.error,
  };
}

/**
 * The status, over a real table.
 *
 * The whole of the query is `readChoreRuns`; everything else is the pure
 * function above. `pnpm chores status` is now one caller of this rather than the
 * only implementation of it.
 */
export async function readChoreStatus(
  db: Kysely<Database>,
  options: { now?: Date; limit?: number } = {},
): Promise<ChoreStatus> {
  const runs = await readChoreRuns(db, { limit: options.limit ?? CHORE_STATUS_LIMIT });
  return choreStatusFrom(runs, { now: options.now ?? new Date() });
}

/**
 * The wire shape, for the bearer-gated route.
 *
 * Dates as ISO strings rather than left to `JSON.stringify`'s Date handling,
 * because the response is a contract an operator reads and the field names and
 * types should be visible in one place. `report` is deliberately absent: it is
 * the one member that can be kilobytes per row, and `pnpm chores status` is
 * where somebody who wants a report goes.
 */
export function choreStatusResponse(status: ChoreStatus): object {
  return {
    checkedAt: status.checkedAt.toISOString(),
    ok: status.ok,
    overdue: status.overdue,
    stalled: status.stalled,
    passes: status.passes.map((entry) => ({
      pass: entry.pass,
      schedules: entry.schedules,
      expectedAt: entry.expectedAt?.toISOString() ?? null,
      overdue: entry.overdue,
      stalled: entry.stalled,
      last:
        entry.last === null
          ? null
          : {
              runId: entry.last.runId,
              source: entry.last.source,
              startedAt: entry.last.startedAt.toISOString(),
              finishedAt: entry.last.finishedAt?.toISOString() ?? null,
              outcome: entry.last.outcome,
              modelCalls: entry.last.modelCalls,
              error: entry.last.error,
            },
    })),
  };
}

/**
 * The same answer, small enough to live on an UNAUTHENTICATED endpoint.
 *
 * `/readyz` is public, so this is the narrowest thing that still answers the
 * operator's question: which passes are late, which are stuck, and when anything
 * last ran. No run ids, no `source`, no error messages, no model-call counts —
 * the full picture is behind the bearer check on `/api/chores?status`, and the
 * digest is what a person reads at a glance after a deploy.
 */
export function choreStatusDigest(status: ChoreStatus): object {
  const startedAt = status.passes
    .map((entry) => entry.last?.startedAt)
    .filter((value): value is Date => value !== undefined);
  return {
    ok: status.ok,
    overdue: status.overdue,
    stalled: status.stalled,
    lastRunAt:
      startedAt.length === 0
        ? null
        : new Date(Math.max(...startedAt.map((value) => value.getTime()))).toISOString(),
  };
}
